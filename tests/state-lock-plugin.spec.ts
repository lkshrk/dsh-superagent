/** The plugin's state directory lock end to end: taken before the Runtime, handed over to it, released on stop and on a failed start. */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, type LockOptions } from 'proper-lockfile'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import type { Runtime } from '../src/app/runtime.ts'

const options = vi.hoisted(() => [] as LockOptions[])
vi.mock('proper-lockfile', async original => {
  const actual = await original<typeof import('proper-lockfile')>()
  return { ...actual, lock: (file: string, given: LockOptions) => { options.push(given); return actual.lock(file, given) } }
})

let dir: string
let stateDir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'state-lock-plugin-')); stateDir = join(dir, 'state'); options.length = 0 })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A host with the services the plugin injects, enough for it to start and wait for setup. */
function host(): Context {
  const ctx = new Context()
  const services: Record<string, unknown> = { agents: new Map(), sessionController: {}, sessionPersistence: { flush: async () => {} }, workspaceRegistry: {},
    tools: {}, systemPrompt: {}, skills: {}, llm: {}, subprocess: {}, webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} } }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  return ctx
}
const start = (ctx: Context) => ctx.plugin(plugin as never, { stateDir, remoteWorkers: true } as never)
const locked = () => check(stateDir, { stale: 30_000 })

it('starts again at once after a stop, as the Runtime holds and releases the lock it was handed', async () => {
  const ctx = host()
  const first = await start(ctx)
  expect(await locked()).toBe(true)
  await first.dispose()
  expect(await locked()).toBe(false)
  const started = Date.now()
  const second = await start(ctx)
  expect(Date.now() - started).toBeLessThan(2000)
  expect(await locked()).toBe(true)
  expect(options).toHaveLength(2)
  await second.dispose()
}, 20_000)

it('leaves the state directory unlocked when the Runtime cannot be built', async () => {
  // A directory where the database belongs makes opening the Store fail.
  mkdirSync(join(stateDir, 'orchestrator.sqlite'), { recursive: true })
  const fiber = start(host())
  await expect(fiber).rejects.toThrow()
  expect(await locked()).toBe(false)
})

it('stops the Runtime\'s work when its lock is compromised', async () => {
  const ctx = host()
  const fiber = await start(ctx)
  const runtime = ctx.get('orchestrator') as Runtime
  expect(runtime.lifetime.aborted).toBe(false)
  options.at(-1)!.onCompromised!(new Error('the lock was taken over'))
  expect(runtime.lifetime.aborted).toBe(true)
  expect(runtime.health.runtime).toMatchObject({ state: 'error', detail: 'the lock was taken over' })
  await fiber.dispose()
}, 20_000)
