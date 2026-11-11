import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSvg, brandIndexHtml, escapeHtml, svgDataUri, DEFAULT_LOGO_SVG } from '../src/brand.js'

test('index.html gets the product name and one icon link', () => {
  const html = '<head><title>DSH Local Build</title><link rel="apple-touch-icon" href="./a.png" />'
    + '<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />'
    + '<link rel="icon" type="image/svg+xml" href="./favicon.svg" /><link rel="stylesheet" href="./x.css"></head>'
  const out = brandIndexHtml(html, { name: 'A&B <Desk>', logoUri: svgDataUri(DEFAULT_LOGO_SVG) })
  assert.match(out, /<title>A&amp;B &lt;Desk&gt;<\/title>/)
  assert.equal(out.match(/rel="icon"/g).length, 1)
  assert.doesNotMatch(out, /favicon|apple-touch-icon/)
  assert.match(out, /rel="stylesheet" href="\.\/x\.css"/)
})

test('logo files must be SVG documents of bounded size', () => {
  assert.equal(assertSvg('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>', 'f'), '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>')
  assert.throws(() => assertSvg('<html></html>', 'f'), /not an SVG/)
  assert.throws(() => assertSvg(`<svg>${'x'.repeat(70000)}</svg>`, 'f'), /64 KiB/)
})

test('escapeHtml covers attribute and element context', () => {
  assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;')
})
