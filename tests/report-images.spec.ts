import { describe, expect, it } from 'vitest'
import { resultText, withReportImages } from '../src/app/report-images.ts'
import type { ChannelRef, Ticket } from '../src/core/index.ts'

const upload = (name: string, signature = 'a') => `https://uploads.linear.app/org/${name}/${name}.png?signature=${signature}`
const report = `Ready: [PR #7](https://github.com/o/r/pull/7).\n\n![before](${upload('before')})\n[after](${upload('after')})`

describe('withReportImages', () => {
  it('embeds a plain link to a report image', () => {
    expect(withReportImages(`[PR #7](https://github.com/o/r/pull/7) is ready: [before](${upload('before', 'b')}), ![after](${upload('after', 'b')})`, report))
      .toBe(`[PR #7](https://github.com/o/r/pull/7) is ready: ![before](${upload('before', 'b')}), ![after](${upload('after', 'b')})`)
  })
  it('appends report images the reply leaves out, once per upload path', () => {
    expect(withReportImages(`Ready: ![before](${upload('before', 'z')})`, `${report}\n![after again](${upload('after', 'c')})`))
      .toBe(`Ready: ![before](${upload('before', 'z')})\n\n![after](${upload('after')})`)
  })
  it('leaves a reply alone when the report has no upload images', () => {
    const text = `Ready: [shot](${upload('other')}) and [PR](https://github.com/o/r/pull/7)`
    expect(withReportImages(text, 'Ready: [PR #7](https://github.com/o/r/pull/7)')).toBe(text)
  })
  it('does not embed an upload link the report does not carry', () => {
    const text = `Ready: [other](${upload('other')})`
    expect(withReportImages(text, report)).toBe(`${text}\n\n![before](${upload('before')})\n\n![after](${upload('after')})`)
  })
})

describe('resultText', () => {
  const ticket = (summary: string, later: 'ready' | 'progress' = 'progress') =>
    ({ assignments: [{ report: { state: 'ready', summary, at: '1' } }, { report: { state: later, summary: 'Later.', at: '2' } }] }) as unknown as Ticket
  const channel = (source: string): ChannelRef => ({ source, thread: 'x', address: {} })
  it('carries the latest ready report images into a Linear result', () => {
    expect(resultText(ticket(report), channel('linear'), 'Ready.')).toBe(`Ready.\n\n![before](${upload('before')})\n\n![after](${upload('after')})`)
  })
  it('leaves other channels alone', () => {
    expect(resultText(ticket(report), channel('feishu'), 'Ready.')).toBe('Ready.')
    expect(resultText(ticket(report), channel('github'), 'Ready.')).toBe('Ready.')
  })
  it('reads only the latest ready report', () => {
    expect(resultText(ticket(report, 'ready'), channel('linear'), 'Ready.')).toBe('Ready.')
  })
})
