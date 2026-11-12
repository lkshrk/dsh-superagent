/** The state directory lock that keeps one dsh-superagent per state directory. */
import { mkdirSync } from 'node:fs'
import { lock } from 'proper-lockfile'

/** A holder refreshes the lock every half of this; a lock older than it was left by a process that is gone. */
export const STATE_LOCK_STALE_MS = 30_000

/** Takes the lock, waiting up to `waitMs` for one a killed process left to go stale; a live holder keeps it fresh, so the wait fails. */
export async function lockStateDir(dir: string, onCompromised: (error: Error) => void,
  { stale = STATE_LOCK_STALE_MS, waitMs = STATE_LOCK_STALE_MS + 15_000 } = {}): Promise<() => Promise<void>> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const step = Math.min(1000, stale / 2)
  return lock(dir, { stale, onCompromised, retries: { retries: Math.ceil(waitMs / step), factor: 1, minTimeout: step, maxTimeout: step } })
}
