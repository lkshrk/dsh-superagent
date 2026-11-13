/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, localId, parseLocal, qualifier, SOURCE, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
/** A PR read from GitHub; `repository` names an additional repository, and is absent in the primary. */
export type Pull = z.infer<typeof PullSchema> & { number: number; repository?: string }
/** A PR a ticket follows: its number, its additional repository if any, and its Thread ID within the Source. */
export interface PullId { number: number; repository?: string; id: string }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal, repository?: string): Promise<Pull> =>
  ({ ...await ctx.commands.repo(repository).withSignal(signal).api(PullSchema, `pulls/${number}`), number, ...repository ? { repository } : {} })
const pullId = (thread: string): PullId | undefined => {
  if (!thread.startsWith(`${SOURCE}:`)) return undefined
  const id = thread.slice(SOURCE.length + 1)
  const { repository, local } = parseLocal(id)
  const number = Number(local)
  return Number.isInteger(number) && number > 0 ? { number, ...repository ? { repository } : {}, id } : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): PullId[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullId(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): PullId | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** The repository a ticket works in: the one its execution records, else the one its origin Trigger names; undefined for the primary. */
export const ticketRepository = (ticket: Pick<Ticket, 'execution'>, origin?: Pick<Trigger, 'meta'>): string | undefined =>
  ticket.execution?.repository ?? qualifier(origin?.meta ?? {})
/** The qualifier of `name` among the deployment's repositories: undefined for the primary or no name; throws for a repository not configured. */
export function pullRepository(deployment: Pick<Deployment, 'repository' | 'repositories'>, name?: string): string | undefined {
  if (!name || sameName(name, deployment.repository)) return undefined
  const known = deployment.repositories.find(repository => sameName(repository, name))
  if (!known) throw new Error(`${name} is not a repository of the GitHub Source`)
  return known
}
const pullThread = (pr: Pick<Pull, 'number' | 'repository'>): string => localId(pr.number, pr.repository)
/** True when the PR was opened by the agent account from a branch in the PR's own repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null; repository?: string },
  deployment: Pick<Deployment, 'github' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', pr.repository ?? deployment.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
    && sameName(qualifier(source.meta) ?? '', pr.repository ?? '')
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const id = pullThread(pr)
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).some(followed => followed.id === id))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${id}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const id = pullThread(pr)
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${id}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(followed => followed.id === id))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`github:${pullThread(pr)}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: pullThread(pr) }, own)
    ctx.threads.patch(`github:${pullThread(pr)}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login, ...pr.repository ? { repository: pr.repository } : {} })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  const id = pullThread(pr)
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).some(followed => followed.id === id))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullId(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const pull = pullId(follow.thread)!
  const { number } = pull
  const url = githubPage(pull.repository ?? repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', pull.id, channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
