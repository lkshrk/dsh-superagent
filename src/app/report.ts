/** Operator log lines: dsh-yawn exports no plugin logger output to the container log, so stderr gets them too. */
import type { Context } from '@deepseek-ai/cordis'
import { format } from 'node:util'

export function report(ctx: Pick<Context, 'logger'>, level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
  ctx.logger[level](message, ...args)
  process.stderr.write(`${format(message, ...args)}\n`)
}
