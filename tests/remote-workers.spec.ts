/** A deployment whose Sessions run their tools in remote sandboxes (`remoteWorkers`), such as under dsh-yawn. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, type Ticket } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import type { Deployment } from '../src/deployment.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('checks setup on this host, leaves the process environment alone, and runs without DSH\'s permission presets', async () => {
  const before = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GH_TOKEN: process.env.GH_TOKEN }
  h = await startRuntime(undefined, { machine: { remoteWorkers: true }, without: ['permissionPresets'] })
  expect(h.runtime.configured()).toBe(true)
  expect(h.runtime.setupProblem).toBeUndefined()
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
  expect({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GH_TOKEN: process.env.GH_TOKEN }).toEqual(before)
  expect(h.agents.has(h.runtime.masterId)).toBe(true)
})

it('starts a worker in its ticket directory without running the prepare command', async () => {
  h = await startRuntime(undefined, { machine: { remoteWorkers: true }, without: ['permissionPresets'] })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR"' } })
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.list()[0]!
  expect(latestAssignment(ticket)?.state).toBe('running')
  expect(existsSync(ticket.execution!.directory)).toBe(true)
  expect(h.agents.has(`worker-${ticket.id}`)).toBe(true)
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
})

describe('repository Workspaces', () => {
  const anchors = mkdtempSync(join(tmpdir(), 'anchors-'))
  afterAll(() => { rmSync(anchors, { recursive: true, force: true }) })
  /** dsh-yawn's sandbox manager: one anchor directory per repository URL. */
  const sandboxManager = (fail = false) => ({ createRepositoryWorkspace: vi.fn(async (url: string) => {
    if (fail) throw new Error('repository workspaces require the dsh Web profile')
    const anchor = join(anchors, url.replace(/\W+/g, '-'))
    mkdirSync(anchor, { recursive: true })
    return anchor
  }) })
  const accept = async (host: Host, id: string, fields: Record<string, unknown> = {}) => {
    const trigger = feishu(id, '@bot 修一下回归')
    host.runtime.receive(trigger)
    await host.runtime.idle()
    await host.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: `fix-${id}`, acknowledgement: '收到。', ...fields })
    await host.runtime.idle()
    return host.runtime.store.tickets.list().find(ticket => ticket.origin.triggerId === trigger.id)!
  }
  const variable = (host: Host, ticket: Ticket, key: string) => host.runtime.ticketEnvironment(ticket).find(item => item.key === key)?.value

  it('starts each new worker in the Workspace of its ticket\'s repository, which the tickets of that repository share', async () => {
    const manager = sandboxManager()
    h = await startRuntime(undefined, { machine: { remoteWorkers: true, repositoryWorkspaces: true }, without: ['permissionPresets'],
      services: { sandboxManager: manager }, repositories: ['other/tools'] })
    const tools = await accept(h, '1', { repository: 'Other/Tools' })
    const primary = await accept(h, '2')
    const again = await accept(h, '3', { repository: 'other/tools' })
    expect(manager.createRepositoryWorkspace.mock.calls).toEqual([['https://github.com/other/tools'], ['https://github.com/acme/widgets'], ['https://github.com/other/tools']])
    expect(tools.execution).toMatchObject({ repository: 'other/tools', directory: join(anchors, 'https-github-com-other-tools') })
    expect(again.execution!.directory).toBe(tools.execution!.directory)
    expect(primary.execution).toMatchObject({ repository: 'acme/widgets', directory: join(anchors, 'https-github-com-acme-widgets') })
    const workspaces = h.controller.create.mock.calls.map(([request]) => request as { sessionId: string; workspaceId?: string })
    expect(workspaces.find(request => request.sessionId === `worker-${tools.id}`)?.workspaceId).toBe(tools.execution!.directory)
    expect(variable(h, tools, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toBe('other/tools')
    expect(variable(h, primary, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toBe('acme/widgets')
    await expect(accept(h, '4', { repository: 'someone/else' })).rejects.toThrow('someone/else is not a repository of the GitHub Source')
  })
  const failure = (host: Host, ticket: Ticket) => host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)?.report
  const machineOf = (host: Host) => host.runtime.machine as { repositoryWorkspaces: boolean }
  it('keeps the ticket\'s own directory when repository Workspaces are off, and fails a launch that cannot have its Workspace', async () => {
    const manager = sandboxManager()
    h = await startRuntime(undefined, { machine: { remoteWorkers: true }, without: ['permissionPresets'], services: { sandboxManager: manager }, repositories: ['other/tools'] })
    const off = await accept(h, '1', { repository: 'other/tools' })
    expect(off.execution).toMatchObject({ repository: 'other/tools', directory: expect.stringMatching(/\/work\/fix-1-/) })
    expect(manager.createRepositoryWorkspace).not.toHaveBeenCalled()
    // A Session that started before the flag was switched on keeps its directory and sandbox.
    machineOf(h).repositoryWorkspaces = true
    await h.runTool(`worker-${off.id}`, 'orchestrator_report', { state: 'failed', summary: 'offline' })
    await h.runtime.engine.retryTicket(off.id)
    await h.runtime.idle()
    expect(manager.createRepositoryWorkspace).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(off.id)!.execution).toEqual(off.execution)
    await h.stop()
    h = await startRuntime(undefined, { machine: { remoteWorkers: true, repositoryWorkspaces: true }, without: ['permissionPresets'] })
    const none = await accept(h, '1')
    await h.runtime.idle()
    expect(failure(h, none)).toMatchObject({ state: 'failed', summary: expect.stringContaining('this host has no dsh-yawn sandbox manager') })
    expect(h.agents.has(`worker-${none.id}`)).toBe(false)
    await h.stop()
    h = await startRuntime(undefined, { machine: { remoteWorkers: true, repositoryWorkspaces: true }, without: ['permissionPresets'], services: { sandboxManager: sandboxManager(true) } })
    const failed = await accept(h, '1')
    await h.runtime.idle()
    expect(failure(h, failed)).toMatchObject({ state: 'failed',
      summary: expect.stringContaining('The dsh-yawn Workspace of https://github.com/acme/widgets could not be created: repository workspaces require the dsh Web profile') })
    expect(h.agents.has(`worker-${failed.id}`)).toBe(false)
  })
  it('creates one Workspace for launches of one repository at once, and leaves a passing network error to the launch\'s retry', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const calls: string[] = []
    let refusals = 1
    const manager = { createRepositoryWorkspace: vi.fn(async (url: string) => {
      calls.push(url)
      await held
      if (refusals-- > 0) throw new Error('connect ECONNRESET 10.0.0.1:443')
      const anchor = join(anchors, url.replace(/\W+/g, '-'))
      mkdirSync(anchor, { recursive: true })
      return anchor
    }) }
    h = await startRuntime(undefined, { machine: { remoteWorkers: true, repositoryWorkspaces: true }, without: ['permissionPresets'], services: { sandboxManager: manager } })
    const triggers = [feishu('1', '@bot 修一下回归'), feishu('2', '@bot 修一下标题')]
    for (const trigger of triggers) h.runtime.receive(trigger)
    await h.runtime.idle()
    await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: triggers.map((trigger, i) =>
      ({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: `fix-${i}`, acknowledgement: '收到。' })) })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    release()
    await vi.waitFor(() => expect(h!.runtime.store.tickets.list().every(ticket => ticket.assignments.at(-1)?.state === 'pending')).toBe(true))
    // Both launches waited for the one creation, which a reset connection failed; neither ticket failed for it.
    expect(calls).toHaveLength(1)
    expect(h.runtime.store.tickets.list().map(ticket => ticket.assignments.at(-1)?.report)).toEqual([undefined, undefined])
  })
  it('works where a GitHub Trigger came from, and fails a launch of a ticket whose repository was taken off the list', async () => {
    h = await startRuntime(undefined, { machine: { remoteWorkers: true }, without: ['permissionPresets'], repositories: ['other/tools'] })
    const comment = (id: number, repository?: string) => commentTrigger({ id, body: '@agent-bot fix the margin', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/${repository ?? 'acme/widgets'}/issues/${id}#issuecomment-${id}` },
    { number: id, isPr: false, repository }, 'conversation', 'agent-bot')
    for (const trigger of [comment(7), comment(8, 'other/tools')]) h.runtime.receive(trigger)
    await h.runtime.idle()
    await expect(h.route({ kind: 'accept', trigger_id: comment(7).id, title: 'fix', worktree_name: 'fix-margin', acknowledgement: 'On it.', repository: 'other/tools' }))
      .rejects.toThrow('The trigger comes from acme/widgets, so its ticket works there')
    await h.route({ kind: 'accept', trigger_id: comment(7).id, title: 'fix', worktree_name: 'fix-margin', acknowledgement: 'On it.', repository: 'ACME/widgets' })
    await h.route({ kind: 'accept', trigger_id: comment(8, 'other/tools').id, title: 'fix', worktree_name: 'fix-tools', acknowledgement: 'On it.' })
    await h.runtime.idle()
    const [primary, tools] = ['fix-margin', 'fix-tools'].map(name => h!.runtime.store.tickets.list().find(ticket => ticket.execution?.name.startsWith(name))!)
    expect(primary!.execution!.repository).toBe('acme/widgets')
    expect(tools!.execution!.repository).toBe('other/tools')
    const setup = (h.runtime as unknown as { setup: { deployment: Deployment } }).setup
    vi.spyOn(setup, 'deployment', 'get').mockReturnValue(testDeployment({ repositories: ['acme/widgets'] }))
    await h.runTool(`worker-${tools!.id}`, 'orchestrator_report', { state: 'failed', summary: 'offline' })
    await h.runtime.engine.retryTicket(tools!.id)
    await h.runtime.idle()
    expect(failure(h, tools!)).toMatchObject({ state: 'failed', summary: expect.stringContaining('other/tools is no longer a repository of the GitHub Source') })
  })
})

it('refuses to start Sessions without DSH\'s permission presets when workers run on this host', async () => {
  await expect(startRuntime(undefined, { without: ['permissionPresets'] })).rejects.toThrow('permission presets service is unavailable')
})

type Guard = (execution: { name: string; arguments: unknown }) => string | undefined
type Tools = { guard: (guard: Guard) => () => void; restrict: (filter: { allow?: readonly string[] }) => () => void }
const toolsOf = (sessionId: string) => (h!.agents.get(sessionId) as unknown as { ctx: { tools: Tools } }).ctx.tools
/** The first reason a Session's guards give for refusing `name`, or undefined when every guard lets it run. */
const refusal = (sessionId: string, name: string) =>
  vi.mocked(toolsOf(sessionId).guard).mock.calls.map(([guard]) => guard({ name, arguments: {} })).find(reason => reason !== undefined)
const allowed = (sessionId: string) => vi.mocked(toolsOf(sessionId).restrict).mock.calls.flatMap(([filter]) => filter.allow ?? [])
const denied = (name: string) => `${name} is not available to dsh-superagent Sessions`
const GLOBAL = ['bash', 'read', 'mcp__searxng__web_search', 'mcp__context7__query_docs', 'mcp__linear__save_issue', 'list_mcp_resources']
/** A runtime with one accepted ticket whose worker runs; `remoteWorkers` as given. */
async function withWorker(remoteWorkers: boolean): Promise<string> {
  h = await startRuntime(undefined, { globalTools: GLOBAL, ...remoteWorkers ? { machine: { remoteWorkers }, without: ['permissionPresets'] } : {} })
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
  await h.runtime.idle()
  return `worker-${h.runtime.store.tickets.list()[0]!.id}`
}
/** DSH creates a Session `id` whose parent is `parent`, as it does for a subagent. */
async function subagent(id: string, parent: string | undefined): Promise<void> {
  await h!.controller.create({ sessionId: id })
  const agent = h!.agents.get(id)! as unknown as { session: { header: { parentSession?: string } } }
  agent.session.header = parent === undefined ? {} : { parentSession: parent }
  await h!.ctx.parallel('agent/created', { agent } as never)
}

it('refuses tools a host registers on each agent, such as dsh-yawn\'s session tools, only when workers run in remote sandboxes', async () => {
  const refused = async (remoteWorkers: boolean) => {
    const worker = await withWorker(remoteWorkers)
    const result = {
      worker: ['create_session', 'install_bundle', 'plugin_source', 'bash', 'orchestrator_report'].map(name => refusal(worker, name)),
      master: ['message_session', 'read', 'orchestrator_route'].map(name => refusal(h!.runtime.masterId, name)),
    }
    await h!.stop(); h = undefined
    return result
  }
  expect(await refused(true)).toEqual({
    worker: [denied('create_session'), denied('install_bundle'), denied('plugin_source'), undefined, undefined],
    master: [denied('message_session'), undefined, undefined],
  })
  expect(await refused(false)).toEqual({ worker: [undefined, undefined, undefined, undefined, undefined], master: [undefined, undefined, undefined] })
})

it('leaves settings and prompt saves to the signed-in panel when workers run in remote sandboxes', async () => {
  await withWorker(true)
  const master = h!.runtime.masterId
  for (const name of ['orchestrator_settings_save', 'orchestrator_prompts_save']) {
    expect(h!.tools.get(master)!.has(name)).toBe(false)
    expect(refusal(master, name)).toBe(denied(name))
  }
  expect(h!.tools.get(master)!.has('orchestrator_route')).toBe(true)
  await h!.stop()
  await withWorker(false)
  expect(['orchestrator_settings_save', 'orchestrator_prompts_save'].map(name => h!.tools.get(h!.runtime.masterId)!.has(name))).toEqual([true, true])
})

it('lets workers and their subagents use the web search and documentation MCP servers, and no other MCP tool', async () => {
  const worker = await withWorker(true)
  await subagent('child-1', worker)
  for (const id of [worker, 'child-1']) {
    expect(allowed(id)).toEqual(['read', 'bash', 'mcp__searxng__web_search', 'mcp__context7__query_docs'])
    expect(['mcp__searxng__web_search', 'mcp__context7__query_docs', 'mcp__searxng__later_tool'].map(name => refusal(id, name))).toEqual([undefined, undefined, undefined])
    expect(['mcp__linear__save_issue', 'list_mcp_resources', 'create_session', 'mcp__searxngx__a'].map(name => refusal(id, name)))
      .toEqual([denied('mcp__linear__save_issue'), denied('list_mcp_resources'), denied('create_session'), denied('mcp__searxngx__a')])
  }
  expect(allowed(h!.runtime.masterId).some(name => name.startsWith('mcp__'))).toBe(false)
  expect(refusal(h!.runtime.masterId, 'mcp__searxng__web_search')).toBe(denied('mcp__searxng__web_search'))
})

it('refuses every tool of a subagent it cannot place when workers run in remote sandboxes, and leaves other Sessions alone', async () => {
  const worker = await withWorker(true)
  const refusedAll = 'dsh-superagent cannot tell whose subagent this is; its tools are refused'
  // Deeper than the parent walk follows.
  let parent = worker
  for (let depth = 1; depth <= 10; depth++) { await subagent(`deep-${depth}`, parent); parent = `deep-${depth}` }
  expect(refusal('deep-8', 'bash')).toBeUndefined()
  expect(refusal('deep-10', 'bash')).toBe(refusedAll)
  // A worker Session whose ticket is gone, and a parent that is not loaded.
  await subagent('orphan-1', 'worker-missing')
  await subagent('lost-1', 'not-loaded')
  expect(['orphan-1', 'lost-1'].map(id => refusal(id, 'read'))).toEqual([refusedAll, refusedAll])
  // A person's own Session and its subagent.
  await subagent('person', undefined)
  await subagent('person-child', 'person')
  expect(['person', 'person-child'].map(id => vi.mocked(toolsOf(id).guard).mock.calls.length)).toEqual([0, 0])
})
