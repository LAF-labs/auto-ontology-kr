/**
 * CSV writing for prepared inputs and reading for artifact previews
 * (RFC 4180: comma, CRLF or LF, double-quote escaping).
 */

function cell(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * @param {string[]} names - header names.
 * @param {unknown[][]} rows - rows in header order; null becomes an empty cell.
 * @returns {string} CSV text ending in a newline.
 */
export function toCsv(names, rows) {
  const lines = [names.map(cell).join(',')]
  for (const row of rows) lines.push(names.map((_name, index) => cell(row[index])).join(','))
  return `${lines.join('\n')}\n`
}

/**
 * Parses CSV text into a header and rows of strings.
 * @param {string} text
 * @param {{ maxRows?: number }} [options] - data rows kept; the rest are counted only.
 * @returns {{ columns: string[], rows: string[][], rowCount: number }}
 */
export function parseCsv(text, { maxRows = Infinity } = {}) {
  const records = []
  let count = 0
  let record = []
  let field = ''
  let quoted = false
  let any = false
  const endRecord = () => {
    record.push(field)
    field = ''
    if (record.length > 1 || record[0] !== '' || any) {
      if (count === 0 || records.length <= maxRows) records.push(record)
      count += 1
    }
    record = []
    any = false
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1 } else quoted = false
      } else field += char
    } else if (char === '"') {
      quoted = true
      any = true
    } else if (char === ',') {
      record.push(field)
      field = ''
      any = true
    } else if (char === '\n') {
      endRecord()
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1
      endRecord()
    } else field += char
  }
  if (field !== '' || record.length > 0 || any) endRecord()
  const [columns = [], ...rows] = records
  return { columns, rows: rows.slice(0, maxRows === Infinity ? undefined : maxRows), rowCount: Math.max(0, count - 1) }
}
