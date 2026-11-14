/** A deployment whose Sessions run their tools in remote sandboxes (`remoteWorkers`), such as under dsh-yawn. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, type Ticket, type Trigger } from '../src/core/index.ts'
import { format } from 'node:util'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { feishu, startRuntime, toolDefinition, type Host } from './fixtures/host.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { observePull, pullRepository, ticketRepository } from '../src/sources/github-pull.ts'
import { workingDirectory } from '../src/app/execution-environment.ts'
import { ticketDetails } from '../src/app/cards.ts'
import { ticketSummary } from '../src/app/views/records.ts'
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
    expect(tools.execution).toMatchObject({ repository: 'other/tools', workspace: join(anchors, 'https-github-com-other-tools'), directory: expect.stringMatching(/\/work\/fix-1-/) })
    expect(again.execution!.workspace).toBe(tools.execution!.workspace)
    // A ticket of the primary records no repository, so it follows the primary whatever it is named.
    expect(primary.execution).not.toHaveProperty('repository')
    expect(primary.execution!.workspace).toBe(join(anchors, 'https-github-com-acme-widgets'))
    const workspaces = h.controller.create.mock.calls.map(([request]) => request as { sessionId: string; workspaceId?: string })
    expect(workspaces.find(request => request.sessionId === `worker-${tools.id}`)?.workspaceId).toBe(tools.execution!.workspace)
    expect(variable(h, tools, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toBe('other/tools')
    expect(variable(h, tools, 'DSH_SUPERAGENT_DIR')).toBe(tools.execution!.workspace)
    expect(variable(h, primary, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toBe('acme/widgets')
    expect(ticketDetails(tools, [], [], false, h.runtime.machine).directory).toBe(tools.execution!.workspace)
    expect(ticketSummary(tools, h.runtime.machine).directory).toBe(tools.execution!.workspace)
    expect(ticketSummary(tools).directory).toBe(tools.execution!.directory)
    // Switched off, the ticket's own directory is its directory again.
    expect(workingDirectory(tools.execution, { remoteWorkers: true, repositoryWorkspaces: false })).toBe(tools.execution!.directory)
    expect(workingDirectory(tools.execution, { remoteWorkers: false, repositoryWorkspaces: true })).toBe(tools.execution!.directory)
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
  it('moves tickets that recorded the primary, or a shared Workspace as their directory, to the form tickets have now', async () => {
    const ticket = (id: string, execution: Record<string, unknown>) => ({ id, title: id, decisionId: `d-${id}`, channels: [], assignments: [], inputs: [], undelivered: [],
      mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
      createdAt: '', updatedAt: '', origin: { triggerId: `source-${id}`, triggerIds: [] }, execution: { name: id, assignment: '', ...execution } }) as unknown as Ticket
    h = await startRuntime(store => {
      store.tickets.save(ticket('t1', { directory: '/anchors/widgets', repository: 'ACME/widgets', shared: true }))
      store.tickets.save(ticket('t2', { directory: '/anchors/tools', repository: 'other/tools', shared: true }))
      store.tickets.save(ticket('t3', { directory: '/w/t3' }))
    }, { machine: { remoteWorkers: true, repositoryWorkspaces: true }, without: ['permissionPresets'], repositories: ['other/tools'] })
    const work = join(h.directory, 'work')
    expect(['t1', 't2', 't3'].map(id => h!.runtime.store.tickets.get(id)!.execution)).toEqual([
      { name: 't1', assignment: '', directory: join(work, 't1'), workspace: '/anchors/widgets' },
      { name: 't2', assignment: '', directory: join(work, 't2'), workspace: '/anchors/tools', repository: 'other/tools' },
      { name: 't3', assignment: '', directory: '/w/t3' }])
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
    expect(primary!.execution).not.toHaveProperty('repository')
    expect(tools!.execution!.repository).toBe('other/tools')
    const setup = (h.runtime as unknown as { setup: { deployment: Deployment } }).setup
    // The primary renamed, or another primary configured: the primary's tickets go on there, and bind its PRs.
    const renamed = testDeployment({ repository: 'acme/renamed', repositories: ['acme/renamed', 'other/tools'] })
    const deployment = vi.spyOn(setup, 'deployment', 'get').mockReturnValue(renamed)
    await h.runTool(`worker-${primary!.id}`, 'orchestrator_report', { state: 'failed', summary: 'offline' })
    await h.runtime.engine.retryTicket(primary!.id)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(primary!.id)!.assignments.at(-1)?.state).toBe('running')
    expect(pullRepository(renamed, ticketRepository(primary!, h.runtime.store.triggers.get(primary!.origin.triggerId)))).toBeUndefined()
    const context = h.runtime.context({ kind: 'github', health: ['github'] })
    await observePull(context, { number: 30, title: 'Fix', state: 'open', html_url: 'https://github.com/acme/renamed/pull/30', user: { login: 'agent-bot' },
      head: { sha: 'abc', ref: `agent/${primary!.execution!.name}`, repo: { full_name: 'acme/renamed' } } })
    expect(h.runtime.store.tickets.get(primary!.id)!.follows).toEqual([{ thread: 'github:30', own: true }])
    deployment.mockReturnValue(testDeployment({ repositories: ['acme/widgets'] }))
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

describe('the Linear tools of a worker splitting an epic', () => {
  const EPIC = '2f1d7a0e-5b1c-4c3e-9a63-0d7b1e4f8a21'
  const LINEAR = ['get_issue', 'list_issues', 'list_comments', 'list_issue_labels', 'list_issue_statuses', 'save_issue', 'save_comment', 'delete_comment']
    .map(name => `mcp__linear__${name}`)
  const trigger = (id: string, source: string, meta: Record<string, unknown>) => ({ id, source, threads: [{ source, id }], actor: { source, id: 'alice' },
    human: true, at: '2026-11-13T00:00:00Z', text: 'split it', meta }) as Trigger
  const ticket = (id: string, origin: string, ended?: boolean) => ({ id, title: id, decisionId: `d-${id}`, channels: [], assignments: [], inputs: [], undelivered: [],
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'linear', id: 'alice' }, scope: '' },
    createdAt: '', updatedAt: '', origin: { triggerId: origin, triggerIds: [origin] },
    ...ended ? { ended: { at: '2026-11-13T00:00:00Z', by: 'person', outcome: 'stopped' } } : {} }) as unknown as Ticket
  const tickets = { split: 'linear:split', plain: 'linear:plain', github: 'github:split', ended: 'linear:ended' }
  const UNLINKED = GLOBAL.filter(name => !name.startsWith('mcp__linear__'))
  async function start(globalTools: string[] = [...UNLINKED, ...LINEAR], realTools = false): Promise<void> {
    h = await startRuntime(store => {
      store.triggers.save(trigger('t-split', 'linear', { mode: 'split', issue: EPIC, identifier: 'ROU-592' }))
      store.triggers.save(trigger('t-plain', 'linear', { issue: EPIC, identifier: 'ROU-592' }))
      store.triggers.save(trigger('t-github', 'github', { mode: 'split', issue: EPIC, identifier: 'ROU-592' }))
      store.tickets.save(ticket(tickets.split, 't-split'))
      store.tickets.save(ticket(tickets.plain, 't-plain'))
      store.tickets.save(ticket(tickets.github, 't-github'))
      store.tickets.save(ticket(tickets.ended, 't-split', true))
    }, { globalTools, machine: { remoteWorkers: true }, without: ['permissionPresets'], realTools })
    for (const id of Object.values(tickets)) await subagent(`worker-${id}`, undefined)
  }
  const call = (sessionId: string, name: string, args: unknown = {}) =>
    vi.mocked(toolsOf(sessionId).guard).mock.calls.map(([guard]) => guard({ name, arguments: args })).find(reason => reason !== undefined)
  const READS = LINEAR.slice(0, 5)
  const UPLOAD_TYPE = 'Only image/png, image/jpeg, image/webp uploads are allowed'
  const UPLOAD_SIZE = 'Upload size must be a whole number of bytes from 1 to 10 MiB'
  const UPLOAD_NAME = 'Upload filename must be 1 to 200 characters without / or \\'
  /** What reached stderr, the only output of a plugin's that reaches dsh-yawn's container log. */
  const stderr: string[] = []
  beforeEach(() => {
    stderr.length = 0
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true })
  })

  it('lets a split worker and its subagents read Linear and create sub-issues of its epic only', async () => {
    await start()
    const worker = `worker-${tickets.split}`
    await subagent('split-child', worker)
    for (const id of [worker, 'split-child']) {
      expect(allowed(id)).toEqual(['read', 'bash', 'mcp__searxng__web_search', 'mcp__context7__query_docs', ...LINEAR.slice(0, 6)])
      expect(READS.map(name => call(id, name))).toEqual(READS.map(() => undefined))
      for (const parentId of [EPIC, EPIC.toUpperCase(), 'ROU-592', 'rou-592']) {
        expect(call(id, 'mcp__linear__save_issue', { title: 'Part', team: 'ROU', parentId })).toBeUndefined()
      }
      expect(call(id, 'mcp__linear__save_issue', { id: 'ROU-700', parentId: 'ROU-592', title: 'Moved' }))
        .toBe('Only new sub-issues of ROU-592 may be created; updating an issue is refused')
      for (const args of [{ title: 'Part', parentId: 'ROU-593' }, { title: 'Part' }, { title: 'Part', parentId: 592 }, undefined]) {
        expect(call(id, 'mcp__linear__save_issue', args)).toBe('Only sub-issues of ROU-592 may be created')
      }
      expect(['mcp__linear__save_comment', 'mcp__linear__delete_comment'].map(name => call(id, name)))
        .toEqual([denied('mcp__linear__save_comment'), denied('mcp__linear__delete_comment')])
      expect(['mcp__searxng__web_search', 'mcp__context7__query_docs'].map(name => call(id, name))).toEqual([undefined, undefined])
    }
  })

  it('refuses every Linear tool to other workers, their subagents, an ended ticket\'s worker and the main Session', async () => {
    await start()
    await subagent('plain-child', `worker-${tickets.plain}`)
    for (const id of [`worker-${tickets.plain}`, 'plain-child', `worker-${tickets.github}`]) {
      expect(allowed(id)).toEqual(['read', 'bash', 'mcp__searxng__web_search', 'mcp__context7__query_docs'])
      expect(LINEAR.map(name => call(id, name, { parentId: 'ROU-592' }))).toEqual(LINEAR.map(denied))
      expect(['mcp__searxng__web_search', 'mcp__context7__query_docs'].map(name => call(id, name))).toEqual([undefined, undefined])
    }
    const ended = 'Ticket ended; new work needs a new authorized ticket'
    expect([...LINEAR, 'mcp__searxng__web_search', 'bash'].map(name => call(`worker-${tickets.ended}`, name, { parentId: 'ROU-592' })))
      .toEqual([...LINEAR, 'mcp__searxng__web_search', 'bash'].map(() => ended))
    const master = h!.runtime.masterId
    expect(allowed(master).some(name => name.startsWith('mcp__'))).toBe(false)
    expect(LINEAR.map(name => call(master, name, { parentId: 'ROU-592' }))).toEqual(LINEAR.map(denied))
  })

  describe('in DSH\'s tool registry', () => {
    // As dsh-yawn names them: its server `linear` mounts LiteLLM's `linear_app` endpoint, which prefixes each tool with its name.
    const SERVED = (server: string, names: string[]) => names.map(name => `mcp__${server}__${server === 'linear' ? 'linear_app' : server}-${name}`)
    const LITELLM = SERVED('linear', ['get_issue', 'list_issues', 'list_comments', 'list_issue_labels', 'list_issue_statuses', 'save_issue', 'save_comment'])
    const SEARCH = SERVED('searxng', ['searxng_web_search'])
    const registry = () => h!.ctx.tools as unknown as ToolRuntime
    const agentOf = (id: string) => h!.agents.get(id) as never
    const mcpOf = (id: string) => registry().schemas().map(tool => tool.name)
      .filter(name => (name.startsWith('mcp__') || name.includes('mcp_resource')) && registry().get(name, agentOf(id)) !== undefined)
    /** The first reason the registry's guards, global then along the agent's scope chain, give for refusing a call. */
    const reason = (id: string, name: string, args: unknown = {}) => (registry() as unknown as { guardReason: (exec: unknown) => string | undefined })
      .guardReason({ name, arguments: args, agent: agentOf(id) })
    const logs: string[] = []
    /** Mounts MCP servers at the host root, as dsh-yawn does once they connect; returns their unmount. */
    const connect = (names: string[]) => { const disposers = names.map(name => registry().register(toolDefinition(name) as never)); return () => { disposers.forEach(dispose => { dispose() }) } }
    beforeEach(() => { logs.length = 0 })
    async function startReal(): Promise<void> {
      await start(['list_mcp_resources'], true)
      h!.ctx.logger.exporter({ levels: { default: 3 }, export: message => { logs.push(`${message.type}: ${format(...message.args as [string])}`) } })
    }

    it('admits the Linear tools of servers that connect after the split worker and its subagent started, and keeps them across a reconnect', async () => {
      await startReal()
      const worker = `worker-${tickets.split}`
      await subagent('split-child', worker)
      expect(mcpOf(worker)).toEqual([])
      const disconnect = connect([...SEARCH, ...LITELLM, 'mcp__context7__context7-query-docs'])
      for (const id of [worker, 'split-child']) {
        expect(mcpOf(id)).toEqual([...SEARCH, ...LITELLM.slice(0, 6), 'mcp__context7__context7-query-docs'])
        expect(reason(id, LITELLM[5]!, { title: 'Part', parentId: 'ROU-592' })).toBeUndefined()
        expect(reason(id, LITELLM[5]!, { title: 'Part', parentId: 'ROU-1' })).toBe('Only sub-issues of ROU-592 may be created')
        expect(reason(id, LITELLM[5]!, { id: 'ROU-700', parentId: 'ROU-592' })).toBe('Only new sub-issues of ROU-592 may be created; updating an issue is refused')
        expect([LITELLM[6]!, 'list_mcp_resources'].map(name => reason(id, name))).toEqual([denied(LITELLM[6]!), denied('list_mcp_resources')])
      }
      for (const id of [`worker-${tickets.plain}`, `worker-${tickets.github}`]) {
        expect(mcpOf(id)).toEqual([...SEARCH, 'mcp__context7__context7-query-docs'])
        expect(LITELLM.map(name => reason(id, name, { parentId: 'ROU-592' }))).toEqual(LITELLM.map(denied))
      }
      const master = h!.runtime.masterId
      expect(mcpOf(master)).toEqual([])
      expect(LITELLM.map(name => reason(master, name, { parentId: 'ROU-592' }))).toEqual(LITELLM.map(denied))
      disconnect()
      expect(mcpOf(worker)).toEqual([])
      connect(LITELLM)
      expect(mcpOf(worker)).toEqual(LITELLM.slice(0, 6))
      expect(logs).toContain(`info: dsh-superagent built the tools of ${worker} for ticket ${tickets.split} splitting ROU-592; Linear tools: none yet`)
      expect(logs).toContain(`info: dsh-superagent built the tools of ${worker} for ticket ${tickets.split} splitting ROU-592; Linear tools: ${LITELLM.slice(0, 6).join(', ')}`)
      expect(stderr.filter(line => line.includes(`worker-${tickets.plain}`)))
        .toEqual([`dsh-superagent built the tools of worker-${tickets.plain} for Linear ticket ${tickets.plain}; Linear tools: none yet\n`])
      expect(stderr.filter(line => line.includes(`worker-${tickets.github}`))).toEqual([])
      expect(stderr).toContain(`dsh-superagent built the tools of ${worker} for ticket ${tickets.split} splitting ROU-592; Linear tools: ${LITELLM.slice(0, 6).join(', ')}\n`)
    })

    it('admits prepare_file_upload to every Linear worker and its subagent once the server connects, and to no other Session', async () => {
      await startReal()
      const [upload] = SERVED('linear', ['prepare_file_upload'])
      await subagent('plain-child', `worker-${tickets.plain}`)
      connect([...LITELLM, upload!])
      expect(mcpOf(`worker-${tickets.split}`)).toEqual([...LITELLM.slice(0, 6), upload])
      for (const id of [`worker-${tickets.plain}`, 'plain-child']) {
        expect(mcpOf(id)).toEqual([upload])
        expect(reason(id, upload!, { filename: 'shot.png', contentType: 'image/png', size: 2048 })).toBeUndefined()
        expect(reason(id, upload!, { filename: 'shot.svg', contentType: 'image/svg+xml', size: 2048 })).toBe(UPLOAD_TYPE)
      }
      for (const id of [`worker-${tickets.github}`, h!.runtime.masterId]) {
        expect(mcpOf(id)).toEqual([])
        expect(reason(id, upload!, { filename: 'shot.png', contentType: 'image/png', size: 2048 })).toBe(denied(upload!))
      }
      expect(logs).toContain(`info: dsh-superagent built the tools of worker-${tickets.plain} for Linear ticket ${tickets.plain}; Linear tools: ${upload}`)
      expect(stderr).toContain(`dsh-superagent built the tools of worker-${tickets.plain} for Linear ticket ${tickets.plain}; Linear tools: ${upload}\n`)
    })

    it('gives a split worker re-created after a restart the Linear tools of servers that connected before it', async () => {
      await startReal()
      const worker = `worker-${tickets.split}`
      connect(LITELLM)
      await h!.ctx.parallel('agent/disposed', { agent: h!.agents.get(worker) } as never)
      h!.agents.delete(worker)
      await subagent(worker, undefined)
      expect(mcpOf(worker)).toEqual(LITELLM.slice(0, 6))
    })

    it('warns when a split worker still has no Linear tools a minute after it started, unless they came or it was released', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await startReal()
        const worker = `worker-${tickets.split}`
        const warnings = () => logs.filter(line => line.startsWith('warn: ') && line.includes('still has no Linear tools'))
        vi.advanceTimersByTime(59_999)
        expect(warnings()).toEqual([])
        vi.advanceTimersByTime(1)
        const warning = `dsh-superagent split worker ${worker} for ticket ${tickets.split} still has no Linear tools 60 s after it started; `
          + 'is the linear MCP server connected?'
        expect(warnings()).toEqual([`warn: ${warning}`])
        expect(stderr.filter(line => line.includes('still has no Linear tools'))).toEqual([`${warning}\n`])
        const recreate = async () => { await release(); await subagent(worker, undefined) }
        const release = async () => { await h!.ctx.parallel('agent/disposed', { agent: h!.agents.get(worker) } as never); h!.agents.delete(worker) }
        await recreate()
        await release()
        vi.advanceTimersByTime(60_000)
        await subagent(worker, undefined)
        connect(LITELLM)
        vi.advanceTimersByTime(60_000)
        expect(warnings()).toHaveLength(1)
      } finally { vi.useRealTimers() }
    })
  })

  describe('prepare_file_upload', () => {
    const UPLOADS = ['mcp__linear__prepare_file_upload', 'mcp__linear__linear_app-prepare_file_upload']
    const WITH_UPLOAD = [...UNLINKED, ...LINEAR, ...UPLOADS]
    const IMAGE = { filename: 'screenshot.png', contentType: 'image/png', size: 4096 }

    it('admits only prepare_file_upload, by its bare and prefixed names, to a Linear worker that does not split, and its subagent', async () => {
      await start(WITH_UPLOAD)
      await subagent('plain-child', `worker-${tickets.plain}`)
      for (const id of [`worker-${tickets.plain}`, 'plain-child']) {
        expect(allowed(id)).toEqual(['read', 'bash', 'mcp__searxng__web_search', 'mcp__context7__query_docs', ...UPLOADS])
        expect(UPLOADS.map(name => call(id, name, IMAGE))).toEqual([undefined, undefined])
        expect(LINEAR.map(name => call(id, name, { parentId: 'ROU-592' }))).toEqual(LINEAR.map(denied))
      }
    })

    it('admits the six split tools and prepare_file_upload to a split worker', async () => {
      await start(WITH_UPLOAD)
      const worker = `worker-${tickets.split}`
      expect(allowed(worker).filter(name => name.startsWith('mcp__linear__'))).toEqual([...LINEAR.slice(0, 6), ...UPLOADS])
      expect(UPLOADS.map(name => call(worker, name, IMAGE))).toEqual([undefined, undefined])
    })

    it('refuses prepare_file_upload to a GitHub worker, its subagent and the main Session', async () => {
      await start(WITH_UPLOAD)
      await subagent('github-child', `worker-${tickets.github}`)
      for (const id of [`worker-${tickets.github}`, 'github-child', h!.runtime.masterId]) {
        expect(allowed(id).some(name => name.startsWith('mcp__linear__'))).toBe(false)
        expect(UPLOADS.map(name => call(id, name, IMAGE))).toEqual(UPLOADS.map(denied))
      }
    })

    it('accepts PNG, JPEG and WebP images up to 10 MiB with a plain file name, and refuses anything else', async () => {
      await start(WITH_UPLOAD)
      const worker = `worker-${tickets.plain}`
      for (const name of UPLOADS) {
        const upload = (args: Record<string, unknown> | undefined) => call(worker, name, args === undefined ? undefined : { ...IMAGE, ...args })
        for (const contentType of ['image/png', 'image/jpeg', 'image/webp']) expect(upload({ contentType })).toBeUndefined()
        for (const size of [1, 10 * 1024 * 1024]) expect(upload({ size })).toBeUndefined()
        expect(upload({ filename: 'a'.repeat(200) })).toBeUndefined()
        for (const contentType of ['image/svg+xml', 'application/pdf', 'IMAGE/PNG', 7]) expect(upload({ contentType })).toBe(UPLOAD_TYPE)
        for (const size of [0, -1, 10 * 1024 * 1024 + 1, 1.5, '4096', Number.NaN]) expect(upload({ size })).toBe(UPLOAD_SIZE)
        for (const filename of ['', 'a'.repeat(201), '../shot.png', 'dir/shot.png', 'dir\\shot.png', 42]) expect(upload({ filename })).toBe(UPLOAD_NAME)
        expect(upload(undefined)).toBe(UPLOAD_TYPE)
      }
    })
  })

  it('keeps the previous mask when a rebuild fails, and rebuilds again on a later change', async () => {
    const tools = [...UNLINKED]
    await start(tools)
    const worker = `worker-${tickets.split}`
    const agentCtx = (h!.agents.get(worker) as unknown as { ctx: { emit: (event: 'tools/change') => void } }).ctx
    const restrict = vi.mocked(toolsOf(worker).restrict)
    const first = vi.fn()
    restrict.mockReset()
    tools.push('mcp__linear__get_issue')
    restrict.mockImplementationOnce(() => { throw new Error('unknown global tool') })
    expect(() => { agentCtx.emit('tools/change') }).not.toThrow()
    expect(restrict).toHaveBeenCalledTimes(1)
    expect(stderr).toContain(`dsh-superagent could not update the tools of ${worker}: Error: unknown global tool\n`)
    // DSH emits tools/change from inside restrict and dispose; a nested change neither recurses nor rebuilds twice.
    restrict.mockImplementation(() => { agentCtx.emit('tools/change'); return first })
    agentCtx.emit('tools/change')
    expect(restrict).toHaveBeenCalledTimes(2)
    expect(restrict.mock.calls.at(-1)![0].allow).toEqual(['read', 'bash', 'mcp__searxng__web_search', 'mcp__context7__query_docs', 'mcp__linear__get_issue'])
    tools.push('mcp__linear__save_issue')
    agentCtx.emit('tools/change')
    expect(restrict).toHaveBeenCalledTimes(3)
    expect(first).toHaveBeenCalledTimes(1)
  })
})
