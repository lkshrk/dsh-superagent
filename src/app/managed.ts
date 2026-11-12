/** Settings and team prompt sections that the plugin configuration manages, applied at every start through the panel's own save paths. */
import type { SettingsBlock } from '../policy.ts'
import type { Managed } from '../managed.ts'
import { defaultPrompts, savePrompts, type Prompts, type TeamSection } from './prompts.ts'
import type { Settings } from './settings.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

export interface ManagedHost {
  readonly settings: Pick<Settings, 'block' | 'save'>
  readonly store: Pick<Store, 'atomic'>
  readonly prompts: Pick<Prompts, 'current' | 'save'>
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  warn(message: string): void
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function saveBlock(host: ManagedHost, block: SettingsBlock, merge: (current: Record<string, unknown>) => unknown): Promise<void> {
  try {
    const { value, revision } = host.settings.block(block)
    await host.settings.save(block, merge(value as Record<string, unknown>), revision, 'config')
  } catch (error) { host.warn(`managed ${block} settings were not applied: ${reason(error)}`) }
}

/** Applies the managed policy, eval and executor blocks and team prompt sections; Source blocks wait for their kind, see `applyManagedSource`. */
export async function applyManaged(host: ManagedHost, managed: Managed): Promise<void> {
  const { policy, eval: evaluation, executor, prompts } = managed
  if (policy) {
    await saveBlock(host, 'policy', current => {
      const sources = current.sources as Record<string, Record<string, unknown>>
      return { ...current, ...policy.rules ? { rules: policy.rules } : {},
        sources: { ...sources, ...Object.fromEntries(Object.entries(policy.sources ?? {}).map(([id, part]) => [id, { ...sources[id], ...part }])) } }
    })
  }
  if (evaluation) await saveBlock(host, 'eval', current => ({ ...current, ...evaluation }))
  if (executor) await saveBlock(host, 'executor', current => ({ ...current, ...executor }))
  if (prompts) {
    try {
      const current = host.prompts.current()
      const defaults = defaultPrompts()
      const sections = Object.fromEntries(Object.entries(prompts).map(([section, value]) =>
        [section, typeof value === 'string' ? value : `${defaults[section as TeamSection].trimEnd()}\n\n${value!.append}`]))
      const config = { ...current.config, ...sections }
      if (JSON.stringify(config) !== JSON.stringify(current.config)) await savePrompts(host, config, current.revision, 'config')
    } catch (error) { host.warn(`managed prompt sections were not applied: ${reason(error)}`) }
  }
}

/** Applies the managed block of Source `id`, which can be saved only once its kind is registered. */
export async function applyManagedSource(host: ManagedHost, managed: Managed, id: string): Promise<void> {
  const part = managed.sources?.[id]
  if (!part) return
  await saveBlock(host, `source:${id}`, current => ({ enabled: part.enabled ?? current.enabled,
    config: { ...current.config as Record<string, unknown>, ...part.config } }))
}
