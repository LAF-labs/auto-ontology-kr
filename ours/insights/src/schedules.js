/**
 * Scheduled tasks of the Host Schedule service (`ctx.schedule`) as the
 * Reports screen shows them: title, repeat in words, next run, on or off.
 * No harness imports.
 */

const WEEKDAYS = { MO: '월', TU: '화', WE: '수', TH: '목', FR: '금', SA: '토', SU: '일' }
const ISO_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일']
const pad = n => String(n).padStart(2, '0')

/**
 * Repeat rule in words, e.g. `매달 1일 09:00`, `매주 월요일 09:00`, `한 번`.
 * Unknown shapes fall back to `사용자 지정`.
 * @param {object} record - stored timing record (`kind` and its fields).
 * @returns {string}
 */
export function repeatText(record) {
  if (record.kind === 'at' || record.kind === 'after') return '한 번'
  if (record.kind === 'every') return record.everySeconds % 3600 === 0 ? `${record.everySeconds / 3600}시간마다` : `${Math.round(record.everySeconds / 60)}분마다`
  if (record.kind === 'daily') return `매일 ${record.time.slice(0, 5)}`
  if (record.kind === 'weekly') return `매주 ${record.weekdays.map(d => ISO_WEEKDAYS[d - 1]).join('·')}요일 ${record.time.slice(0, 5)}`
  if (record.kind !== 'rrule') return '사용자 지정'
  const start = /DTSTART(?:;TZID=[^:]+)?:(\d{8})T(\d{2})(\d{2})/.exec(record.rrule)
  const rule = Object.fromEntries((/RRULE:(.*)$/m.exec(record.rrule)?.[1] ?? '').split(';').filter(Boolean).map(part => part.split('=')))
  const clock = start === null ? '' : ` ${start[2]}:${start[3]}`
  if (rule.COUNT === '1') return '한 번'
  const every = rule.INTERVAL !== undefined && rule.INTERVAL !== '1' ? rule.INTERVAL : ''
  switch (rule.FREQ) {
    case 'DAILY': return `${every ? `${every}일마다` : '매일'}${clock}`
    case 'WEEKLY': {
      const days = (rule.BYDAY ?? '').split(',').filter(Boolean).map(d => WEEKDAYS[d.slice(-2)]).filter(Boolean)
      return `${every ? `${every}주마다` : '매주'}${days.length > 0 ? ` ${days.join('·')}요일` : ''}${clock}`
    }
    case 'MONTHLY': {
      const day = rule.BYMONTHDAY !== undefined && !rule.BYMONTHDAY.includes(',') ? ` ${rule.BYMONTHDAY === '-1' ? '말일' : `${rule.BYMONTHDAY}일`}` : start === null ? '' : ` ${Number(start[1].slice(6))}일`
      return `${every ? `${every}달마다` : '매달'}${day}${clock}`
    }
    case 'HOURLY': return every ? `${every}시간마다` : '매시간'
    case 'MINUTELY': return every ? `${every}분마다` : '매분'
    default: return '사용자 지정'
  }
}

/** Browser row for one catalog entry. */
export function scheduleRow(entry) {
  const next = entry.status === 'active'
    ? [entry.scheduledAt, entry.deliveryFloorEndsAt].filter(Boolean).sort().at(-1) ?? null
    : null
  return {
    id: entry.id, title: entry.title, status: entry.status, repeat: repeatText(entry), next_at: next,
    last_delivered_at: entry.lastDelivery?.deliveredAt ?? null, updated_at: entry.updatedAt ?? null,
  }
}
