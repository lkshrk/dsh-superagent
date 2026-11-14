/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { report } from './app/report.ts'
import { Runtime } from './app/runtime.ts'
import { lockStateDir } from './app/state-lock.ts'
import { Config, machineOf, type DeploymentConfig, type Machine } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { report(ctx, 'error', 'dsh-superagent restart failed: %s', String(error)) })
  }
  // Sessions on this host need DSH's permission presets; remote sandboxes run without them, and dsh-yawn leaves them out.
  if (machine.remoteWorkers) await start(ctx, machine, restart)
  else ctx.inject(['permissionPresets'], child => start(child, machine, restart))
}
async function start(ctx: Context, machine: Machine, restart: () => void): Promise<void> {
  let runtime: Runtime | undefined
  const release = await lockStateDir(machine.stateDir, error => {
    if (runtime) runtime.lockCompromised(error)
    else report(ctx, 'error', 'dsh-superagent lost its state directory lock: %s', error.message)
  })
  try { runtime = new Runtime(ctx, machine, restart, release) }
  catch (error) { await release().catch(() => {}); throw error }
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  report(ctx, 'info', '%s', runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
