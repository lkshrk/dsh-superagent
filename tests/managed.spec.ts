/** Settings and team prompt sections the plugin configuration manages (`managed`), applied at every start like a panel save. */
import { afterEach, expect, it, vi } from 'vitest'
import { applyManaged, applyManagedSource } from '../src/app/managed.ts'
import { TEAM_SECTIONS, defaultPrompts } from '../src/app/prompts.ts'
import { MANAGED_SECTIONS, type Managed } from '../src/managed.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const BRANCH = 'Create the branch agent/$DSH_SUPERAGENT_NAME for the ticket before your first commit.'
const managed: Managed = {
  sources: { github: { config: { pollSeconds: 120, observeIssues: true } } },
  policy: { sources: { github: { allowed: [{ id: 'lkshrk' }] } } },
  eval: { mode: 'observe' },
  executor: { maxWorkers: 1 },
  prompts: { delivery: { append: BRANCH } },
}
const host = (warnings: string[] = []) => ({ settings: h!.runtime.settings, store: h!.runtime.store, prompts: h!.runtime.prompts,
  sessions: h!.runtime.sessions, warn: (message: string) => { warnings.push(message) } })

it('applies managed settings and prompt sections at start, recorded as the plugin configuration\'s saves, and leaves other keys alone', async () => {
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 4, directory: '/srv/work' }, eval: { ...settings.eval, mode: 'auto', timeoutSeconds: 300 } })
  }, { machine: { managed } })
  expect(h.runtime.store.settings().executor).toMatchObject({ maxWorkers: 1, directory: '/srv/work' })
  // The fixture saves its own policy and accept mode once the Runtime is ready, as a person would; the next start restores them.
  await applyManaged(host(), managed)
  const settings = h.runtime.store.settings()
  expect(settings.eval).toMatchObject({ mode: 'observe', timeoutSeconds: 300 })
  expect(settings.policy.sources.github!.allowed).toEqual([{ id: 'lkshrk' }])
  expect(settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
  const prompts = h.runtime.prompts.current()
  expect(prompts.source).toBe('config')
  expect(prompts.config.delivery).toBe(`${defaultPrompts().delivery.trimEnd()}\n\n${BRANCH}`)
  expect(prompts.config.scope).toBe(defaultPrompts().scope)
  // The GitHub Source's block waits for its kind, which registers once the Runtime is ready.
  await vi.waitFor(() => { expect(h!.runtime.store.settings().sources.github!.config).toMatchObject({ pollSeconds: 120, observeIssues: true, repository: 'acme/widgets' }) })
})

it('saves nothing when the stored settings already hold the managed values, and restores a managed key a panel save changed', async () => {
  h = await startRuntime(undefined, { machine: { managed } })
  await vi.waitFor(() => { expect(h!.runtime.store.settings().sources.github!.config).toMatchObject({ pollSeconds: 120 }) })
  const revisions = () => [h!.runtime.store.blockRevision('executor'), h!.runtime.store.blockRevision('policy'), h!.runtime.store.blockRevision('eval'),
    h!.runtime.store.blockRevision('source:github'), h!.runtime.prompts.current().revision]
  const warnings: string[] = []
  await applyManaged(host(warnings), managed)
  const before = revisions()
  await applyManaged(host(warnings), managed)
  await applyManagedSource(host(warnings), managed, 'github')
  expect(revisions()).toEqual(before)
  const { value, revision } = h.runtime.settings.block('executor')
  await h.runtime.settings.save('executor', { ...value as object, maxWorkers: 3, prepare: 'make worktree' }, revision, 'panel')
  await applyManaged(host(warnings), managed)
  expect(h.runtime.store.settings().executor).toMatchObject({ maxWorkers: 1, prepare: 'make worktree' })
  expect(warnings).toEqual([])
})

it('reports a managed block its schema refuses and still applies the others', async () => {
  const warnings: string[] = []
  h = await startRuntime()
  await applyManaged(host(warnings), { executor: { maxWorkers: 0 }, eval: { mode: 'off' } })
  expect(warnings).toEqual([expect.stringMatching(/^managed executor settings were not applied: /)])
  expect(h.runtime.store.settings().eval.mode).toBe('off')
})

it('refuses a managed block with unknown keys, and runs as before without one', () => {
  expect(() => machineOf(Config({ stateDir: '/srv/state', managed: { executer: {} } } as never))).toThrow('invalid managed block')
  expect(() => machineOf(Config({ stateDir: '/srv/state', managed: { prompts: { tone: 'x' } } } as never))).toThrow('invalid managed block')
  expect(machineOf(Config({ stateDir: '/srv/state' }))).not.toHaveProperty('managed')
  expect(MANAGED_SECTIONS).toEqual(TEAM_SECTIONS)
})
