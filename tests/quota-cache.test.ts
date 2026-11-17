/**
 * The memoised quota reading on the request path.
 *
 * Every chat turn consults the quota before it starts. `fetchQuota()` answered
 * that from a five-minute cache but still allocated a promise, and the shim's
 * gate allocated a watchdog timer around it. `peekQuota()` exposes the same
 * reading with neither, and these cases pin that it (a) returns what was cached,
 * (b) never goes to the network on its own, (c) expires, and (d) is cleared by
 * the same invalidation the card and the login use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchQuota, invalidateQuotaCache, peekQuota } from '../src/doubao-quota.ts'

afterEach(() => {
  invalidateQuotaCache()
  vi.unstubAllGlobals()
})

describe('peekQuota', () => {
  it('returns the cached reading and does not call out on its own', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('offline') })
    vi.stubGlobal('fetch', fetchMock)
    const first = await fetchQuota({ force: true })
    const callsAfterFetch = fetchMock.mock.calls.length
    const peeked = peekQuota()
    expect(peeked).toBe(first)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFetch)
  })

  it('reports "unknown" once the reading is past its TTL', async () => {
    await fetchQuota({ force: true })
    const now = Date.now()
    expect(peekQuota(now)).toBeDefined()
    // Both TTLs (5 min for a reading, 30 s for a failure) are bounded by an hour.
    expect(peekQuota(now + 60 * 60 * 1000)).toBeUndefined()
  })

  it('is cleared by the same invalidation the card and the login use', async () => {
    await fetchQuota({ force: true })
    expect(peekQuota()).toBeDefined()
    invalidateQuotaCache()
    expect(peekQuota()).toBeUndefined()
  })
})
