/** The Linear upload images of a worker's ready report, kept in the Linear result that delivers it. */
import type { ChannelRef, Ticket } from '../core/index.ts'

const UPLOAD = /(!?)\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g
/** Signed upload URLs differ per read, so an upload is known by its path. */
const uploadPath = (url: string): string => new URL(url).pathname

/** Embeds the report's upload images in `text`: a plain link to one becomes an image, and one `text` leaves out is appended. */
export function withReportImages(text: string, report: string): string {
  const images = new Map<string, string>()
  for (const [, , label, url] of report.matchAll(UPLOAD)) {
    const path = uploadPath(url!)
    if (!images.has(path)) images.set(path, `![${label}](${url})`)
  }
  if (!images.size) return text
  const shown = new Set<string>()
  const embedded = text.replace(UPLOAD, (link, bang: string, label: string, url: string) => {
    const path = uploadPath(url)
    if (!images.has(path)) return link
    shown.add(path)
    return bang ? link : `![${label}](${url})`
  })
  const missing = [...images].filter(([path]) => !shown.has(path)).map(([, image]) => image)
  return missing.length ? `${embedded}\n\n${missing.join('\n\n')}` : embedded
}

/** A ticket's result as it goes to `channel`: on Linear, with the upload images of the ticket's latest ready report. */
export function resultText(ticket: Ticket, channel: ChannelRef, text: string): string {
  const report = ticket.assignments.findLast(assignment => assignment.report?.state === 'ready')?.report
  return channel.source === 'linear' && report ? withReportImages(text, report.summary) : text
}
