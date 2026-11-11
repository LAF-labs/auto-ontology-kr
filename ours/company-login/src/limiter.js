/**
 * Failed sign-in counter held in memory. One bucket per client address plus
 * one shared bucket, so an attacker who changes addresses is still slowed. A
 * bucket that reaches its limit refuses every attempt, correct or not, until
 * its window ends. A restart clears the counts.
 */
export class AttemptLimiter {
  constructor({ maxFailures, windowMs, globalMaxFailures, now = Date.now, maxClients = 10000 }) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.globalMaxFailures = globalMaxFailures
    this.now = now
    this.maxClients = maxClients
    this.clients = new Map()
    this.global = { count: 0, start: 0 }
  }

  bucket(key) {
    const now = this.now()
    const current = this.clients.get(key)
    if (current !== undefined && now - current.start < this.windowMs) return current
    if (current !== undefined) this.clients.delete(key)
    return undefined
  }

  globalBucket() {
    if (this.now() - this.global.start >= this.windowMs) this.global = { count: 0, start: this.now() }
    return this.global
  }

  /** Milliseconds the caller must wait, or 0 when an attempt may proceed. */
  retryAfterMs(key) {
    const now = this.now()
    const client = this.bucket(key)
    if (client !== undefined && client.count >= this.maxFailures) return client.start + this.windowMs - now
    const shared = this.globalBucket()
    if (shared.count >= this.globalMaxFailures) return shared.start + this.windowMs - now
    return 0
  }

  /** Count one failed attempt. */
  fail(key) {
    const now = this.now()
    const client = this.bucket(key)
    if (client === undefined) {
      if (this.clients.size >= this.maxClients) this.prune()
      this.clients.set(key, { count: 1, start: now })
    } else {
      client.count += 1
    }
    this.globalBucket().count += 1
  }

  /** Forget an address after it signs in. The shared bucket keeps its count. */
  succeed(key) {
    this.clients.delete(key)
  }

  prune() {
    const now = this.now()
    for (const [key, value] of this.clients) {
      if (now - value.start >= this.windowMs) this.clients.delete(key)
    }
    // Still full of live buckets: drop the oldest entries. The shared bucket keeps limiting.
    for (const key of this.clients.keys()) {
      if (this.clients.size < this.maxClients) break
      this.clients.delete(key)
    }
  }
}
