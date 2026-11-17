/**
 * A quota read belongs to the account it was issued for.
 *
 * `invalidateQuotaCache()` used to clear the memo only: a read that started
 * before a re-login still wrote its answer into `cached` when it landed, and
 * `peekQuota()` then served the previous account's windows to the chat gate
 * until the five-minute TTL expired. `inFlight` also survived, so a forced
 * refresh could join that stale request instead of starting a new one.
 *
 * These cases pin the generation guard: a stale read may still answer its own
 * caller, but it never becomes the cache.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/doubao-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doubao-auth.ts')>()
  return {
    ...actual,
    loadDoubaoCredentials: () => ({
      ok: true,
      header: 'sessionid=test; msToken=test',
      pairs: new Map([['sessionid', 'test'], ['msToken', 'test']]),
    }),
  }
})

import { fetchQuota, invalidateQuotaCache, peekQuota } from '../src/doubao-quota.ts'

const PAYLOAD = {
  data: {
    member_info: { hasActiveSubscription: true },
    current_subscription: { display: { short_name: 'Test Plan' } },
    window_limit_section: { window_limit_groups: [] },
    incentive_quota_section: { window_limit_groups: [] },
  },
}

afterEach(() => {
  invalidateQuotaCache()
  vi.unstubAllGlobals()
})

describe('quota generation', () => {
  it('never publishes a reading that started before invalidation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      // A fresh Response per call: a body can be read only once, and two fetches
      // must not share one.
      return new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = fetchQuota({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    invalidateQuotaCache()
    release()

    const stale = await pending
    expect(stale.plan).toBe('Test Plan')
    // The answer reached its caller, but the cache stayed empty.
    expect(peekQuota()).toBeUndefined()
  })

  it('starts a fresh request after invalidation instead of joining the stale one', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    void fetchQuota({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    invalidateQuotaCache()

    // invalidation dropped `inFlight`, so this call is NOT coalesced onto the
    // request that belonged to the previous account.
    const second = fetchQuota({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    release()
    const fresh = await second
    expect(fresh.plan).toBe('Test Plan')
    expect(peekQuota()?.plan).toBe('Test Plan')
  })
})
