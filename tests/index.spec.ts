import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import * as plugin from '../src/index.ts'
import { apply, inject } from '../src/index.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; stopped: boolean; locked?: () => Promise<void> }[])
const locks = vi.hoisted(() => ({ taken: [] as string[], released: 0 }))
vi.mock('../src/app/state-lock.ts', () => ({ lockStateDir: async (dir: string) => { locks.taken.push(dir); return async () => { locks.released++ } } }))
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void, readonly locked?: () => Promise<void>) { runtimes.push(this) }
  stopped = false
  configured() { return true }
  async stop() { this.stopped = true }
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((services: string[], callback: (child: unknown) => void) => {
      callback(services.includes('permissionPresets') ? ctx : { effect: (effect: () => unknown) => effect(), settings: { configure } })
    }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('loads without DSH\'s permission presets, which a host whose shells run in remote sandboxes leaves out', () => {
  expect(inject).not.toContain('permissionPresets')
})

describe('permission presets', () => {
  const services = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
  async function host(remoteWorkers: boolean) {
    const ctx = new Context()
    for (const name of services) ctx.reflect.provide(name, {})
    const before = runtimes.length
    await ctx.plugin(plugin as never, { stateDir: '/srv/state', remoteWorkers } as never)
    return { ctx, started: () => runtimes.length - before }
  }
  it('starts the Runtime on this host only once DSH\'s permission presets are active, and again after they restart', async () => {
    const { ctx, started } = await host(false)
    expect(started()).toBe(0)
    const presets = ctx.reflect.provide('permissionPresets', { set: () => {} })
    await vi.waitFor(() => { expect(started()).toBe(1) })
    const first = runtimes.at(-1)!
    presets()
    await vi.waitFor(() => { expect(first.stopped).toBe(true) })
    ctx.reflect.provide('permissionPresets', { set: () => {} })
    await vi.waitFor(() => { expect(started()).toBe(2) })
    expect(runtimes.at(-1)!.stopped).toBe(false)
  })
  it('starts the Runtime without DSH\'s permission presets when workers run in remote sandboxes', async () => {
    const { started } = await host(true)
    expect(started()).toBe(1)
  })
})

it('takes the state directory lock before it starts the Runtime, and hands it over', async () => {
  const { ctx } = context()
  locks.taken.length = 0
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  expect(locks.taken).toEqual(['/srv/state'])
  const released = locks.released
  await runtimes.at(-1)!.locked!()
  expect(locks.released).toBe(released + 1)
})
