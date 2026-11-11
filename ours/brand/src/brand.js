/** Brand values and the index.html rewrite, kept free of Cordis so they can be tested directly. */

/** Placeholder until the product is named. */
export const DEFAULT_NAME = '데이터 분석 워크스페이스'

/** Neutral mark: three rising bars in a rounded square. `currentColor` follows the page's text color. */
export const DEFAULT_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
  + '<rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#2f6bff"/>'
  + '<rect x="6.5" y="12" width="3" height="6" rx="1" fill="#fff"/>'
  + '<rect x="10.5" y="8.5" width="3" height="9.5" rx="1" fill="#fff"/>'
  + '<rect x="14.5" y="5.5" width="3" height="12.5" rx="1" fill="#fff"/></svg>'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ESCAPES[ch])
}

/** An SVG document as a data URI usable in `<img src>` and `<link rel="icon" href>`. */
export function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/**
 * Refuse logo files that are not a plain SVG document. The markup is only ever
 * used through a data URI in `<img>` and `<link rel="icon">`, where scripts do
 * not run, so this guards against a wrong file, not against hostile markup.
 */
export function assertSvg(svg, source) {
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) throw new Error(`brand: ${source} is not an SVG document`)
  if (Buffer.byteLength(svg, 'utf8') > 64 * 1024) throw new Error(`brand: ${source} is larger than 64 KiB`)
  return svg
}

/**
 * Put the product name and icon into the served index.html: the static
 * `<title>` (shown until the client sets its own) and every `rel="icon"` and
 * `rel="apple-touch-icon"` link.
 */
export function brandIndexHtml(html, brand) {
  const icon = `<link rel="icon" type="image/svg+xml" href="${brand.logoUri}" />`
  let seen = false
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(brand.name)}</title>`)
    .replace(/<link\s[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/gi, () => {
      if (seen) return ''
      seen = true
      return icon
    })
}
