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

it('refuses tools a host registers on each agent, such as dsh-yawn\'s session tools, only when workers run in remote sandboxes', async () => {
  const refused = async (remoteWorkers: boolean) => {
    h = await startRuntime(undefined, remoteWorkers ? { machine: { remoteWorkers }, without: ['permissionPresets'] } : {})
    const trigger = feishu('1', '@bot 修一下回归')
    h.runtime.receive(trigger)
    await h.runtime.idle()
    await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await h.runtime.idle()
    const worker = `worker-${h.runtime.store.tickets.list()[0]!.id}`
    const check = (sessionId: string, name: string) => {
      type Guard = (execution: { name: string; arguments: unknown }) => string | undefined
      const agent = h!.agents.get(sessionId) as unknown as { ctx: { tools: { guard: (guard: Guard) => () => void } } }
      const guards = vi.mocked(agent.ctx.tools.guard).mock.calls.map(([guard]) => guard)
      return guards.map(guard => guard({ name, arguments: {} })).find(reason => reason !== undefined)
    }
    const result = {
      worker: ['create_session', 'install_bundle', 'plugin_source', 'bash', 'orchestrator_report'].map(name => check(worker, name)),
      master: ['message_session', 'read', 'orchestrator_route'].map(name => check(h!.runtime.masterId, name)),
    }
    await h.stop(); h = undefined
    return result
  }
  const denied = (name: string) => `${name} is not available to dsh-superagent Sessions`
  expect(await refused(true)).toEqual({
    worker: [denied('create_session'), denied('install_bundle'), denied('plugin_source'), undefined, undefined],
    master: [denied('message_session'), undefined, undefined],
  })
  expect(await refused(false)).toEqual({ worker: [undefined, undefined, undefined, undefined, undefined], master: [undefined, undefined, undefined] })
})
