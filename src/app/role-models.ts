/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel, Settings } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** The worker model for a ticket: the first rule naming one of `labels` (case-insensitive), else `executor.model`. */
export function workerModel(executor: Pick<Settings['executor'], 'model' | 'modelRules'>, labels: unknown): RoleModel | null {
  const names = new Set((Array.isArray(labels) ? labels : []).filter(label => typeof label === 'string').map(label => label.trim().toLowerCase()))
  return executor.modelRules.find(rule => names.has(rule.label.toLowerCase()))?.model ?? executor.model
}

/** Seed a role's model onto a session before its first request; a `model` getter runs only when the seed still applies. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null | (() => Promise<RoleModel | null>)): Promise<void> {
  const seeded = () => !!agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')
  if (!model || seeded()) return
  const chosen = typeof model === 'function' ? await model() : model
  if (!chosen || seeded()) return
  const selected = await resolveRoleModel(ctx, chosen)
  if (seeded()) return
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}
