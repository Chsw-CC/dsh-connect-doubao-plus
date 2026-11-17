/**
 * Time and concurrency bounds on the quota read.
 *
 * The quota endpoint is consulted before every chat turn and by the settings
 * card on a timer, so its failure modes are the request's failure modes:
 *
 *   - no ceiling  -> a black-holed socket holds a turn open indefinitely;
 *   - no coalescing -> the first second of a burst is one request per caller,
 *     because the response cache is only written once a response LANDS.
 *
 * Neither is visible in a happy-path test, so both are pinned here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { invalidateQuotaCache, QUOTA_REQUEST_TIMEOUT_MS } from '../src/doubao-quota.ts'

vi.mock('../src/doubao-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doubao-auth.ts')>()
  const pairs = new Map(actual.REQUIRED_COOKIE_NAMES.map((name) => [name, 'test']))
  return {
    ...actual,
    loadDoubaoCredentials: () => ({
      ok: true as const,
      header: [...pairs].map(([name, value]) => `${name}=${value}`).join('; '),
      pairs,
    }),
  }
})

/** The smallest 200 body `fetchQuota` will accept. */
function quotaBody(): Response {
  return new Response(JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  invalidateQuotaCache()
})

describe('fetchQuota', () => {
  it('sends one request for concurrent callers', async () => {
    const { fetchQuota } = await import('../src/doubao-quota.ts')
    const realFetch = globalThis.fetch
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (!String(input).includes('/quota/summary/')) return realFetch(input, init)
      calls += 1
      // Hold the response so both callers are in flight together.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return quotaBody()
    }))

    const [a, b, c] = await Promise.all([fetchQuota(), fetchQuota(), fetchQuota()])
    expect(calls).toBe(1)
    expect(a.fetchedAt).toBe(b.fetchedAt)
    expect(b.fetchedAt).toBe(c.fetchedAt)
  })

  it('arms a deadline on the request and names a timeout for what it is', async () => {
    const { fetchQuota } = await import('../src/doubao-quota.ts')
    let armed: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      armed = init?.signal ?? undefined
      // A real `AbortSignal.timeout` rejection: the DOMException name is what
      // the classifier keys on, and `instanceof Error` is false for it — the
      // regression this pins is reporting "undefined" to the user.
      const timeout = new Error('The operation was aborted due to timeout')
      timeout.name = 'TimeoutError'
      throw timeout
    }))

    const quota = await fetchQuota()
    // A signal is handed to fetch at all: without one a black-holed socket has
    // no ceiling, and the turn waits on the OS.
    expect(armed).toBeInstanceOf(AbortSignal)
    expect(QUOTA_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
    // ...and the failure reads as a timeout, not as a mystery.
    expect(quota.error).toContain('未响应')
    expect(quota.windows).toEqual([])
  })
})
