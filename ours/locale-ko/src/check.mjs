/** Checks a Korean dictionary set against the English snapshot it was translated from. */

const placeholders = text => (text.match(/\{[A-Za-z0-9_.]+\}/g) ?? []).sort().join(' ')

/**
 * Problems that would break the UI: a key or namespace English does not have
 * (a typo that never shows), a non-string value, a placeholder set that differs
 * from the English text, or a zero-width space or byte-order mark.
 * @returns one line per problem.
 */
export function checkDictionaries(ko, en) {
  const problems = []
  for (const [ns, dict] of Object.entries(ko)) {
    if (en[ns] === undefined) { problems.push(`${ns}: namespace is not in en.snapshot.json`); continue }
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string') { problems.push(`${ns}: ${key} is not a string`); continue }
      const source = en[ns][key]
      if (source === undefined) { problems.push(`${ns}: ${key} is not in en.snapshot.json`); continue }
      if (placeholders(value) !== placeholders(source)) problems.push(`${ns}: ${key} placeholders differ from English (${placeholders(source) || 'none'})`)
      if (/[​﻿]/.test(value)) problems.push(`${ns}: ${key} contains a zero-width space or byte-order mark`)
    }
  }
  return problems
}

/** English keys with no Korean entry, as `namespace: key`. */
export function missingKeys(ko, en) {
  const missing = []
  for (const [ns, dict] of Object.entries(en)) {
    for (const key of Object.keys(dict)) {
      if (ko[ns]?.[key] === undefined) missing.push(`${ns}: ${key}`)
    }
  }
  return missing
}
