/**
 * What started the Session that saves a report: a scheduled task of the Host
 * Schedule service (`ctx.schedule`), found by its delivery receipts, or the
 * Session itself. The model's `schedule_id` argument is only a hint that is
 * checked against the task's saved deliveries. No harness imports.
 */

/**
 * @param {{catalog: () => Promise<object[]>, history: (request: object) => Promise<object>}|undefined} schedule
 * @param {string|undefined} sessionId
 * @param {string|undefined} hintId - schedule id the model passed.
 * @returns {Promise<{kind: 'schedule', schedule_id: string, schedule_title: string, occurrence_at: string|null} | {kind: 'session'}>}
 */
export async function reportTrigger(schedule, sessionId, hintId) {
  if (schedule === undefined || typeof sessionId !== 'string') return { kind: 'session' }
  const entries = await schedule.catalog()
  const describe = (entry, receipt) => ({ kind: 'schedule', schedule_id: entry.id, schedule_title: entry.title, occurrence_at: receipt?.scheduledAt ?? null })
  const byReceipt = entries.find(entry => entry.lastDelivery?.targetSessionId === sessionId)
  if (byReceipt !== undefined) return describe(byReceipt, byReceipt.lastDelivery)
  const candidates = hintId === undefined ? [] : entries.filter(entry => entry.id === hintId)
  for (const entry of candidates) {
    const page = await schedule.history({ id: entry.id, limit: 50 })
    const record = page.records?.find(r => r.targetSessionId === sessionId)
    if (record !== undefined) return describe(entry, record)
  }
  const byTarget = entries.find(entry => entry.target?.sessionId === sessionId && entry.lastDelivery !== undefined)
  if (byTarget !== undefined) return describe(byTarget, byTarget.lastDelivery)
  return { kind: 'session' }
}
