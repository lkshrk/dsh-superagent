/** The Linear upload images of a worker's ready report, kept in the Linear result that delivers it. */
import type { ChannelRef, Ticket } from '../core/index.ts'

const UPLOAD = String.raw`https:\/\/uploads\.linear\.app\/[^)\s>"]+`
const LINK = new RegExp(String.raw`(!?)\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(\s*<?(${UPLOAD})>?(?:\s+"[^"]*")?\s*\)`, 'g')
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm
/** Linear signs upload URLs per read; the bare path is the stored URL every signed-in viewer can load. */
const canonical = (url: string): string => { const { origin, pathname } = new URL(url); return origin + pathname }

/** Rewrites `text` outside its fenced code blocks. */
function prose(text: string, rewrite: (part: string) => string): string {
  let out = '', at = 0
  for (const fence of text.matchAll(FENCE)) {
    out += rewrite(text.slice(at, fence.index)) + fence[0]
    at = fence.index + fence[0].length
  }
  return out + rewrite(text.slice(at))
}

/** Appends the report's upload images `text` does not embed yet; links stay links, since an image is its own block on Linear. */
export function withReportImages(text: string, report: string): string {
  const images = new Map<string, string>()
  prose(report, part => {
    for (const [, , label, url] of part.matchAll(LINK)) {
      const image = canonical(url!)
      if (!images.has(image)) images.set(image, `![${label}](${image})`)
    }
    return part
  })
  if (!images.size) return text
  const shown = new Set<string>()
  const embedded = prose(text, part => part.replace(LINK, (link, bang: string, label: string, url: string) => {
    const image = canonical(url)
    if (!bang || !images.has(image)) return link
    shown.add(image)
    return `![${label}](${image})`
  }))
  const missing = [...images].filter(([image]) => !shown.has(image)).map(([, markdown]) => markdown)
  return missing.length ? `${embedded}\n\n${missing.join('\n\n')}` : embedded
}

/** A ticket's result as it goes to `channel`: on Linear, with the upload images of the ticket's latest ready report. */
export function resultText(ticket: Ticket, channel: ChannelRef, text: string): string {
  const report = ticket.assignments.findLast(assignment => assignment.report?.state === 'ready')?.report
  return channel.source === 'linear' && report ? withReportImages(text, report.summary) : text
}
