/** Settings and team prompt sections that the plugin configuration manages, applied at every start through the panel's own save paths. */
import type { SettingsBlock } from '../policy.ts'
import type { Managed } from '../managed.ts'
import { defaultPrompts, savePrompts, type Prompts, type TeamSection } from './prompts.ts'
import type { Settings } from './settings.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export interface ManagedHost {
  readonly settings: Pick<Settings, 'block' | 'save'>
  readonly store: Pick<Store, 'atomic'>
  readonly prompts: Pick<Prompts, 'current' | 'save'>
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  readonly sources: Pick<SourceRegistry, 'kind' | 'policyPart'>
  warn(message: string): void
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function saveBlock(host: ManagedHost, block: SettingsBlock, merge: (current: Record<string, unknown>) => unknown): Promise<void> {
  try {
    const { value, revision } = host.settings.block(block)
    await host.settings.save(block, merge(value as Record<string, unknown>), revision, 'config')
  } catch (error) { host.warn(`managed ${block} settings were not applied: ${reason(error)}`) }
}

/** Applies the managed policy rules, eval and executor blocks, team prompt sections and team skills; each Source's parts wait for its kind, see `applyManagedSource`. */
export async function applyManaged(host: ManagedHost, managed: Managed): Promise<void> {
  const { policy, eval: evaluation, executor, prompts } = managed
  if (policy?.rules) await saveBlock(host, 'policy', current => ({ ...current, rules: policy.rules }))
  if (evaluation) await saveBlock(host, 'eval', current => ({ ...current, ...evaluation }))
  if (executor) await saveBlock(host, 'executor', current => ({ ...current, ...executor }))
  if (prompts) {
    try {
      const current = host.prompts.current()
      const defaults = defaultPrompts()
      const { skills, ...managedSections } = prompts
      const sections = Object.fromEntries(Object.entries(managedSections).map(([section, value]) =>
        [section, typeof value === 'string' ? value : `${defaults[section as TeamSection].trimEnd()}\n\n${value!.append}`]))
      const config = { ...current.config, ...sections, ...skills ? { skills: { ...current.config.skills, ...skills } } : {} }
      if (JSON.stringify(config) !== JSON.stringify(current.config)) await savePrompts(host, config, current.revision, 'config')
    } catch (error) { host.warn(`managed prompt sections were not applied: ${reason(error)}`) }
  }
}

/** Applies the managed block and policy part of Source `id`, which can be saved only once its kind is registered. */
export async function applyManagedSource(host: ManagedHost, managed: Managed, id: string): Promise<void> {
  const block = managed.sources?.[id]
  if (block) {
    await saveBlock(host, `source:${id}`, current => ({ enabled: block.enabled ?? current.enabled,
      config: { ...current.config as Record<string, unknown>, ...block.config } }))
  }
  const part = managed.policy?.sources?.[id]
  if (!part) return
  const sync = host.sources.kind(id)?.policy?.sync
  const stored = host.sources.policyPart(id)
  // A Source whose roster sync is ready owns its allowed list, as `Settings.syncable` decides; managing it too would make every start save.
  const owned = 'allowed' in part && sync !== undefined && stored !== undefined && sync.ready({ ...stored, ...part })
  if (owned) host.warn(`managed policy.sources.${id}.allowed was not applied: the Source's ${id} roster sync owns it`)
  const { allowed: _allowed, ...rest } = part
  const applied = owned ? rest : part
  if (!Object.keys(applied).length) return
  await saveBlock(host, 'policy', current => {
    const sources = current.sources as Record<string, Record<string, unknown>>
    return { ...current, sources: { ...sources, [id]: { ...sources[id], ...applied } } }
  })
}
