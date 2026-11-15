import { describe, expect, it } from 'vitest'
import { resultText, withReportImages } from '../src/app/report-images.ts'
import type { ChannelRef, Ticket } from '../src/core/index.ts'

const path = (name: string) => `https://uploads.linear.app/org/${name}/${name}.png`
const upload = (name: string, signature = 'a') => `${path(name)}?signature=${signature}`
const report = `Ready: [PR #7](https://github.com/o/r/pull/7).\n\n![before](${upload('before')})\n[after](${upload('after')})`

describe('withReportImages', () => {
  it('leaves inline links as they are and appends their images as a block, in report order', () => {
    const text = `Screenshots: [before](${upload('before', 'b')}), [after](${upload('after', 'b')}).`
    expect(withReportImages(text, report)).toBe(`${text}\n\n![before](${path('before')})\n\n![after](${path('after')})`)
  })
  it('does not append an image the reply already embeds, and drops the signature of that embed', () => {
    expect(withReportImages(`Ready: [PR](https://github.com/o/r/pull/7)\n\n![after](${upload('after', 'z')})`, `${report}\n![after again](${upload('after', 'c')})`))
      .toBe(`Ready: [PR](https://github.com/o/r/pull/7)\n\n![after](${path('after')})\n\n![before](${path('before')})`)
  })
  it('reads angle-bracket, titled and bracket-labelled links in the reply and in the report', () => {
    expect(withReportImages(`Ready.\n\n![before](<${upload('before', 'y')}> "Before")\n\n![shot [2]](${upload('after', 'y')})`, report))
      .toBe(`Ready.\n\n![before](${path('before')})\n\n![shot [2]](${path('after')})`)
    expect(withReportImages('Ready.', `![before](<${upload('before')}>) [after]( <${upload('after')}> "After")`))
      .toBe(`Ready.\n\n![before](${path('before')})\n\n![after](${path('after')})`)
  })
  it('counts only embedded images as shown, not links or bare URLs', () => {
    const text = `Ready: <${upload('before', 'y')}> and [after](<${upload('after', 'y')}>)`
    expect(withReportImages(text, report)).toBe(`${text}\n\n![before](${path('before')})\n\n![after](${path('after')})`)
  })
  it('leaves fenced code alone and does not count an upload shown only there', () => {
    const code = `\`\`\`\n[before](${upload('before', 'y')})\n\`\`\``
    expect(withReportImages(`Ready.\n${code}\n![after](${path('after')})`, `${report}\n~~~\n![ignored](${upload('ignored')})\n~~~`))
      .toBe(`Ready.\n${code}\n![after](${path('after')})\n\n![before](${path('before')})`)
  })
  it('leaves a reply alone when the report has no upload images', () => {
    const text = `Ready: [shot](${upload('other')}) and [PR](https://github.com/o/r/pull/7)`
    expect(withReportImages(text, 'Ready: [PR #7](https://github.com/o/r/pull/7)')).toBe(text)
  })
  it('does not embed an upload link the report does not carry', () => {
    const text = `Ready: [other](${upload('other')})`
    expect(withReportImages(text, report)).toBe(`${text}\n\n![before](${path('before')})\n\n![after](${path('after')})`)
  })
})

describe('resultText', () => {
  const ticket = (summary: string, later: 'ready' | 'progress' = 'progress') =>
    ({ assignments: [{ report: { state: 'ready', summary, at: '1' } }, { report: { state: later, summary: 'Later.', at: '2' } }] }) as unknown as Ticket
  const channel = (source: string): ChannelRef => ({ source, thread: 'x', address: {} })
  it('carries the latest ready report images into a Linear result', () => {
    expect(resultText(ticket(report), channel('linear'), 'Ready.')).toBe(`Ready.\n\n![before](${path('before')})\n\n![after](${path('after')})`)
  })
  it('leaves other channels alone', () => {
    expect(resultText(ticket(report), channel('feishu'), 'Ready.')).toBe('Ready.')
    expect(resultText(ticket(report), channel('github'), 'Ready.')).toBe('Ready.')
  })
  it('reads only the latest ready report', () => {
    expect(resultText(ticket(report, 'ready'), channel('linear'), 'Ready.')).toBe('Ready.')
  })
})
