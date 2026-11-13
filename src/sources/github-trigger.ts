/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/**
 * The ID of an Issue, PR or CI Thread within the Source: unqualified (`12`, `ci:main`) in the primary repository, and
 * `owner/name#12` in an additional one, whose name `repository` gives.
 */
export const localId = (local: string | number, repository?: string): string => repository ? `${repository}#${local}` : String(local)
/** Splits a Thread ID into its additional repository, if any, and its ID within that repository. */
export function parseLocal(id: string): { repository?: string; local: string } {
  const at = id.indexOf('#')
  const repository = at > 0 ? id.slice(0, at) : ''
  return REPOSITORY.test(repository) ? { repository, local: id.slice(at + 1) } : { local: id }
}
/** The repository qualifier of a Trigger, Thread meta or Channel address: an additional repository's name, or undefined for the primary. */
export const qualifier = (fields: Record<string, unknown>): string | undefined =>
  typeof fields.repository === 'string' && fields.repository ? fields.repository : undefined
const qualified = (repository?: string): Record<string, string> => repository ? { repository } : {}
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (number: number, url?: string, repository?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${localId(number, repository)}`, address: { number: String(number), ...(url ? { url } : {}), ...qualified(repository) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/** Parses a web or API URL for an Issue, PR, or review comment in `repository`; returns undefined for other URLs or repositories. */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string; repository?: string | undefined }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
/** True when `text` mentions `login`; a GitHub App's bot account is also addressed by its App slug, without `[bot]`. */
export function mentions(text: string, login: string): boolean {
  const slug = login.replace(/\[bot\]$/i, '')
  const suffix = slug === login ? '' : '(?:\\[bot\\])?'
  return new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(slug)}${suffix}(?![a-zA-Z0-9_\\[-])`, 'i').test(text)
}
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const thread = localId(ref.number, ref.repository)
  const id = key('github-comment', comment.html_url ?? `github:${thread}`, String(comment.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: thread }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined, ref.repository),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...qualified(ref.repository), ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and body.
 * The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
 */
export function issueTrigger(issue: Opened, agent: string, repository?: string): Trigger {
  const body = issue.body ?? ''
  const thread = localId(issue.number, repository)
  return { id: key('github-issue', thread), source: SOURCE,
    threads: [{ source: SOURCE, id: thread }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url, repository), url: issue.html_url,
    meta: { number: issue.number, isPr: false, ...qualified(repository), kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in GitHub and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(pull: Opened, agent: string, repository?: string): Trigger {
  return { ...issueTrigger(pull, agent, repository), meta: { number: pull.number, isPr: true, ...qualified(repository), prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string, repository?: string): Trigger {
  return { id: key('github-ci', localId(`branch:${branch}`, repository), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: localId(`ci:${branch}`, repository) }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, ...qualified(repository), branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string, repository?: string): Trigger {
  const thread = localId(pr.number, repository)
  return { id: key('github-ci', thread, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(pr.number, undefined, repository), url: pr.html_url,
    meta: { number: pr.number, isPr: true, ...qualified(repository), prAuthor: pr.user.login, ci: true, revision } }
}
