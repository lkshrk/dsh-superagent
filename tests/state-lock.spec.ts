/** The state directory lock: a lock a killed process left behind is taken once stale, a live holder's never. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { lockStateDir } from '../src/app/state-lock.ts'

let dir: string
let stateDir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'state-lock-')); stateDir = join(dir, 'state') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const compromised = (error: Error) => { throw error }

it('waits for the lock a killed process left until it is stale, then takes it', async () => {
  // A killed holder leaves its lock directory, which nobody refreshes any more.
  mkdirSync(stateDir); mkdirSync(`${stateDir}.lock`)
  const started = Date.now()
  const release = await lockStateDir(stateDir, compromised, { stale: 2000, waitMs: 6000 })
  expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
  await release()
}, 15_000)

it('takes a lock that is already stale at once', async () => {
  mkdirSync(stateDir); mkdirSync(`${stateDir}.lock`)
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${stateDir}.lock`, old, old)
  const started = Date.now()
  const release = await lockStateDir(stateDir, compromised, { stale: 2000, waitMs: 6000 })
  expect(Date.now() - started).toBeLessThan(1000)
  await release()
})

it('gives up while a live holder keeps its lock fresh, so only one instance runs', async () => {
  mkdirSync(stateDir)
  const holder = await lock(stateDir, { stale: 2000 })
  await expect(lockStateDir(stateDir, compromised, { stale: 2000, waitMs: 4000 })).rejects.toMatchObject({ code: 'ELOCKED' })
  await holder()
  const release = await lockStateDir(stateDir, compromised, { stale: 2000, waitMs: 4000 })
  await release()
}, 15_000)
