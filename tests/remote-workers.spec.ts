/** A deployment whose Sessions run their tools in remote sandboxes (`remoteWorkers`), such as under dsh-yawn. */
import { existsSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
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
