import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel, workerModel } from '../src/app/role-models.ts'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import { SettingsSchema } from '../src/policy.ts'
import { ticketLabels } from '../src/executor/dsh.ts'
import { issueTrigger, pullTrigger } from '../src/sources/github-trigger.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, flush, request, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('seeds once when another selection lands while the route resolves', async () => {
  const { ctx, agent, resolve } = await fixture()
  resolve.mockImplementationOnce(async value => {
    agent.session.append('model/selection', { provider: 'other', model: 'first' })
    return value
  })
  await initializeRoleModel(ctx, agent, async () => ({ provider: 'worker', model: 'late' }))
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([
    expect.objectContaining({ data: { provider: 'other', model: 'first' } })])
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

const sonnet = { provider: 'litellm', model: 'sonnet' }, opus = { provider: 'litellm', model: 'opus' }, fable = { provider: 'litellm', model: 'fable' }
it.each([
  ['a matching label', [{ label: 'hard', model: fable }], ['bug', 'hard'], fable],
  ['a label in another case', [{ label: 'Hard', model: fable }], ['HARD'], fable],
  ['no labels', [{ label: 'hard', model: fable }], undefined, opus],
  ['no rules', [], ['hard'], opus],
  ['the first matching rule', [{ label: 'big', model: sonnet }, { label: 'hard', model: fable }, { label: 'bug', model: sonnet }], ['bug', 'hard'], fable],
])('picks the worker model by %s', (_name, modelRules, labels, expected) => {
  expect(workerModel({ model: opus, modelRules }, labels)).toEqual(expected)
})
it('falls back to the executor model, or none, for labels that are not a list of names', () => {
  expect(workerModel({ model: opus, modelRules: [{ label: 'hard', model: fable }] }, 'hard')).toEqual(opus)
  expect(workerModel({ model: null, modelRules: [{ label: 'hard', model: fable }] }, [1, null])).toBeNull()
})
it('seeds a new worker Session with the model of its labels\' rule, and the main Session with the eval model', async () => {
  const { ctx } = await fixture()
  const settings = SettingsSchema.parse({ eval: { model: sonnet }, executor: { model: opus, modelRules: [{ label: 'hard', model: fable }] } })
  const agents = new Map<string, Agent>()
  ctx.reflect.provide('sessionController', {
    resolveAgent: async (id: string) => {
      if (!agents.has(id)) agents.set(id, { ctx, session: Session.create(SessionId(id)) } as Agent)
      return { agent: agents.get(id)! }
    },
    rename: async () => {},
  })
  vi.spyOn(Sessions.prototype as unknown as { decorate: () => Promise<void> }, 'decorate').mockResolvedValue()
  const sessions = new Sessions({ context: ctx, store: { settings: () => settings }, effects: { handle: () => {} }, remoteWorkers: true } as unknown as SessionsHost)
  const selected = (agent: Agent) => agent.session.snapshotEvents().find(event => event.type === 'model/selection')?.data
  expect(selected(await sessions.ensure('hard', '/w', 'Hard', 'worker', async () => ['bug', 'Hard']))).toEqual(fable)
  expect(selected(await sessions.ensure('plain', '/w', 'Plain', 'worker', async () => ['bug']))).toEqual(opus)
  const unread = vi.fn(async () => ['hard'])
  expect(selected(await sessions.ensure('main', '/w', 'Main', 'orchestrator', unread))).toEqual(sonnet)
  // A Session that already has its model reads no labels.
  expect(selected(await sessions.ensure('plain', '/w', 'Plain', 'worker', unread))).toEqual(opus)
  expect(unread).not.toHaveBeenCalled()
})
it('reads no labels for a worker Session when no model rules are set', async () => {
  const { ctx } = await fixture()
  const settings = SettingsSchema.parse({ executor: { model: opus } })
  ctx.reflect.provide('sessionController', {
    resolveAgent: async (id: string) => ({ agent: { ctx, session: Session.create(SessionId(id)) } as Agent }),
    rename: async () => {},
  })
  vi.spyOn(Sessions.prototype as unknown as { decorate: () => Promise<void> }, 'decorate').mockResolvedValue()
  const sessions = new Sessions({ context: ctx, store: { settings: () => settings }, effects: { handle: () => {} }, remoteWorkers: true } as unknown as SessionsHost)
  const labels = vi.fn(async () => ['hard'])
  const agent = await sessions.ensure('worker', '/w', 'Worker', 'worker', labels)
  expect(agent.session.snapshotEvents().find(event => event.type === 'model/selection')?.data).toEqual(opus)
  expect(labels).not.toHaveBeenCalled()
})

describe('the labels a GitHub ticket\'s worker model is picked by', () => {
  const opened = { number: 8, title: 'Fix', body: 'please fix', user: { login: 'alice' }, created_at: '2026-09-09T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/issues/8', labels: [{ name: 'hard' }] }
  function host(trigger: Trigger, api: (path: string) => Promise<unknown>, lifetime = new AbortController().signal) {
    const scopes: (string | undefined)[] = [], paths: string[] = []
    const commands = { withSignal: () => ({ repo: (name?: string) => ({ api: async (_schema: unknown, path: string) => {
      scopes.push(name); paths.push(path); return api(path)
    } }) }) }
    return { host: { store: { triggers: { get: () => trigger } }, commands, lifetime } as never, scopes, paths }
  }
  const ticket = (execution?: { repository: string }) => ({ origin: { triggerId: 't' }, ...execution ? { execution } : {} }) as unknown as Ticket
  it('reads an Issue\'s current labels at issues/<number>', async () => {
    const { host: h, paths, scopes } = host(issueTrigger(opened, 'agent-bot'), async () => ({ labels: [{ name: 'Big' }] }))
    expect(await ticketLabels(h, ticket())).toEqual(['Big'])
    expect(paths).toEqual(['issues/8'])
    expect(scopes).toEqual([undefined])
  })
  it('reads in the repository the ticket works in', async () => {
    const { host: h, paths, scopes } = host(pullTrigger(opened, 'agent-bot'), async () => ({ labels: [] }))
    expect(await ticketLabels(h, ticket({ repository: 'acme/gadgets' }))).toEqual([])
    expect(paths).toEqual(['pulls/8'])
    expect(scopes).toEqual(['acme/gadgets'])
  })
  it('reads the trigger\'s repository when the ticket names none', async () => {
    const { host: h, scopes } = host(issueTrigger(opened, 'agent-bot', 'acme/gadgets'), async () => ({ labels: [] }))
    await ticketLabels(h, ticket())
    expect(scopes).toEqual(['acme/gadgets'])
  })
  it('retries a failed read once', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('502')).mockResolvedValueOnce({ labels: [{ name: 'big' }] })
    const { host: h } = host(issueTrigger(opened, 'agent-bot'), api)
    expect(await ticketLabels(h, ticket())).toEqual(['big'])
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('falls back to the trigger\'s labels when both reads fail', async () => {
    const api = vi.fn(async () => { throw new Error('502') })
    const { host: h } = host(issueTrigger(opened, 'agent-bot'), api)
    expect(await ticketLabels(h, ticket())).toEqual(['hard'])
    expect(api).toHaveBeenCalledTimes(2)
  })
  it.each([['missing', {}], ['malformed', { labels: 'hard' }], ['of malformed items', { labels: [{ id: 1 }] }]])(
    'falls back to the trigger\'s labels when the live labels are %s', async (_name, item) => {
      const { host: h } = host(issueTrigger(opened, 'agent-bot'), async () => item)
      expect(await ticketLabels(h, ticket())).toEqual(['hard'])
    })
  it('falls back to the trigger\'s labels when the read hangs past its bound', async () => {
    vi.useFakeTimers()
    try {
      const { host: h } = host(issueTrigger(opened, 'agent-bot'), () => new Promise(() => {}))
      const labels = ticketLabels(h, ticket())
      await vi.advanceTimersByTimeAsync(5000)
      expect(await labels).toEqual(['hard'])
    } finally { vi.useRealTimers() }
  })
  it('throws rather than guess when the runtime stops during the read', async () => {
    const lifetime = new AbortController()
    const { host: h } = host(issueTrigger(opened, 'agent-bot'), () => new Promise(() => {}), lifetime.signal)
    const labels = ticketLabels(h, ticket())
    lifetime.abort()
    await expect(labels).rejects.toThrow('stopping')
  })
})
