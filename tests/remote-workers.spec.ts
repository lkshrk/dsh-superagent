/** A deployment whose Sessions run their tools in remote sandboxes (`remoteWorkers`), such as under dsh-yawn. */
import { existsSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

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
