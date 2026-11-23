/**
 * The check-in layer: protocol mapping, idempotency and the day boundary.
 *
 * Check-in is the one feature whose failures are all ALLOWED to be quiet, which
 * is exactly why the quiet has to be pinned: a broken parser may not look like
 * "this account has no activity", and a scheduler must not retry a dead session
 * into a loop. None of that is visible in a happy-path test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  beijingDayKey,
  claimDoubaoCheckin,
  invalidateCheckinCache,
  readDoubaoCheckin,
  startDoubaoAutoCheckin,
} from '../src/doubao-checkin.ts'

/**
 * A signed-in session, unconditionally.
 *
 * `readDoubaoCheckin` resolves the account through `loadDoubaoCredentials`, which
 * unseals a real file from `~/.dsh`. Without this stub every mapping test below
 * short-circuits into `needs_login` on a machine that has never scanned the QR
 * code — i.e. on CI and on every contributor who is not the maintainer. The
 * assertions are about protocol handling (idempotency, the 710012001 code, the
 * day boundary), none of which involves a live account.
 */
/**
 * Which account the mocked session belongs to.
 *
 * The scheduler's settled day and the claim cooldown are keyed by the live
 * session, so account isolation can only be asserted by actually switching the
 * account between calls. `vi.mock` is hoisted and cannot be re-declared per test;
 * a mutable holder is the way in.
 */
const account = { id: 'test' }

vi.mock('../src/doubao-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doubao-auth.ts')>()
  return {
    ...actual,
    loadDoubaoCredentials: () => ({
      ok: true,
      header: 'sessionid=' + account.id + '; ttwid=test; msToken=test',
      pairs: new Map([
        ['sessionid', account.id],
        ['uid_tt', account.id],
        ['ttwid', 'test'],
        ['msToken', 'test'],
      ]),
    }),
  }
})

/** A panel body in the shape the live endpoint returns. */
function panelBody(options: { checked?: boolean; days?: number } = {}) {
  return {
    code: 0,
    data: {
      progress: { total_amount: 10550 },
      tasks: [
        { task_kind: 'c2b_guide' },
        {
          task_kind: 'daily_signin',
          daily_checkin: {
            checked_in_today: options.checked === true,
            continuous_days: options.days ?? 27,
            reward: { reward_amount: 200, reward_type: 'quota_grant' },
          },
        },
      ],
    },
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let calls: string[]

beforeEach(() => {
  calls = []
  invalidateCheckinCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  invalidateCheckinCache()
})

describe('beijingDayKey', () => {
  it('rolls over at Beijing midnight, not UTC midnight', () => {
    // 2026-11-17T15:59:59Z is 23:59:59 Beijing on the 17th.
    expect(beijingDayKey(Date.parse('2026-11-17T15:59:59Z'))).toBe('2026-11-17')
    // One second later it is the 18th in Beijing, still the 17th in UTC.
    expect(beijingDayKey(Date.parse('2026-11-17T16:00:00Z'))).toBe('2026-11-18')
    expect(beijingDayKey(Date.parse('2026-11-17T16:00:00Z')).slice(0, 10)).not.toBe('2026-11-17')
  })
})

describe('readDoubaoCheckin', () => {
  it('reports a claimed day with its streak and grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      calls.push(String(input))
      return jsonResponse(panelBody({ checked: true, days: 27 }))
    }))
    const view = await readDoubaoCheckin({ force: true })
    expect(view.outcome).toBe('already')
    expect(view.checkedInToday).toBe(true)
    expect(view.continuousDays).toBe(27)
    expect(view.rewardAmount).toBe(200)
    expect(view.totalAmount).toBe(10550)
    // The campaign param set, NOT the chat one: aid 497858 is what this surface keys on.
    expect(calls[0]).toContain('aid=497858')
    expect(calls[0]).not.toContain('582478')
  })

  it('reports an unclaimed day without calling the claim endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(panelBody({ checked: false })))
    vi.stubGlobal('fetch', fetchMock)
    const view = await readDoubaoCheckin({ force: true })
    // «未领取» is a healthy state with work to do, not a failure: the button is
    // the point. Reporting 'failed' here made every normal account look broken.
    expect(view.outcome).toBe('ready')
    expect(view.ok).toBe(true)
    expect(view.checkedInToday).toBe(false)
    expect(view.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls.some((url) => url.includes('landing/checkin'))).toBe(false)
  })

  it('turns a dead session into needs_login, not into an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 710012001 })))
    const view = await readDoubaoCheckin({ force: true })
    expect(view.outcome).toBe('needs_login')
    expect(view.ok).toBe(false)
    expect(view.error).toContain('登录')
  })

  it('turns an account with no activity into no_task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 710010702 })))
    const view = await readDoubaoCheckin({ force: true })
    expect(view.outcome).toBe('no_task')
    expect(view.ok).toBe(false)
  })

  it('survives padding that is not the panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: {} })))
    const view = await readDoubaoCheckin({ force: true })
    expect(view.outcome).toBe('no_task')
    expect(view.ok).toBe(false)
  })

  it('degrades a transport failure to failed instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const view = await readDoubaoCheckin({ force: true })
    expect(view.outcome).toBe('failed')
    expect(view.ok).toBe(false)
  })

  it('coalesces concurrent reads into one request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(panelBody({ checked: true })))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b, c] = await Promise.all([readDoubaoCheckin(), readDoubaoCheckin(), readDoubaoCheckin()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.fetchedAt).toBe(b.fetchedAt)
    expect(b.fetchedAt).toBe(c.fetchedAt)
  })
})

describe('claimDoubaoCheckin', () => {
  it('maps a fresh grant to claimed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('landing/checkin')) return jsonResponse({ code: 0, data: { reward_amount: 200 } })
      return jsonResponse(panelBody({ checked: true }))
    }))
    const view = await claimDoubaoCheckin()
    expect(view.outcome).toBe('claimed')
    expect(view.ok).toBe(true)
    expect(view.rewardAmount).toBe(200)
    expect(view.continuousDays).toBe(27)
  })

  it('maps an idempotent replay to already, not to a second grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('landing/checkin')) {
        return jsonResponse({ code: 0, data: { idempotent: true, reward_amount: 200 } })
      }
      return jsonResponse(panelBody({ checked: true }))
    }))
    const view = await claimDoubaoCheckin()
    expect(view.outcome).toBe('already')
    expect(view.ok).toBe(true)
  })
})

describe('startDoubaoAutoCheckin', () => {
  it('does not call out at all while disabled', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(panelBody({ checked: false })))
    vi.stubGlobal('fetch', fetchMock)
    const handle = startDoubaoAutoCheckin({
      enabled: () => false,
      tickMs: 10,
      firstTickMs: 0,
    })
    const result = await handle.runNow()
    handle.stop()
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('claims once and then leaves the day settled', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('landing/checkin')) return jsonResponse({ code: 0, data: { reward_amount: 200 } })
      return jsonResponse(panelBody({ checked: true }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const seen: string[] = []
    const handle = startDoubaoAutoCheckin({
      enabled: () => true,
      onResult: (view) => seen.push(view.outcome),
      tickMs: 10,
      firstTickMs: 0,
    })
    await handle.runNow()
    const second = await handle.runNow()
    handle.stop()
    expect(seen).toEqual(['claimed'])
    expect(second).toBeNull()
  })
})

describe('claim refusals', () => {
  it('keeps a refused claim retryable instead of inventing no_task', async () => {
    // 710010702 on the CLAIM endpoint is 「系统错误」, not 「该账号没有活动」. Reading
    // it as no_task settled the day for a healthy account: the panel still showed
    // an unclaimed grant, the scheduler had already gone quiet, and nothing
    // ever retried -- the exact shape of the missing-reward bug.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('landing/checkin')) return jsonResponse({ code: 710010702, msg: '系统错误' })
      return jsonResponse(panelBody({ checked: false }))
    }))
    const view = await claimDoubaoCheckin()
    expect(view.outcome).toBe('inactive')
    expect(view.ok).toBe(false)
  })

  it('does not retry a refusal before the cooldown, and does after it', async () => {
    let claims = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('landing/checkin')) {
        claims += 1
        return jsonResponse({ code: 710010702 })
      }
      return jsonResponse(panelBody({ checked: false }))
    }))
    await claimDoubaoCheckin()
    expect(claims).toBe(1)
    // Inside the cooldown a scheduler sweep must not spend another claim...
    const cooled = await claimDoubaoCheckin({ respectCooldown: true })
    expect(claims).toBe(1)
    expect(cooled.outcome).toBe('inactive')
    // ...while a user's explicit press may, immediately.
    await claimDoubaoCheckin()
    expect(claims).toBe(2)
  })

  it('settles each account separately', async () => {
    // Signing in as a second account used to inherit the first account's
    // "done today" and skip its claim with no request at all: a missing reward
    // that looked like nothing was wrong.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('landing/checkin')) return jsonResponse({ code: 0, data: { reward_amount: 200 } })
      return jsonResponse(panelBody({ checked: true }))
    }))
    account.id = 'first'
    const handle = startDoubaoAutoCheckin({ enabled: () => true, tickMs: 10, firstTickMs: 0 })
    expect((await handle.runNow())?.outcome).toBe('claimed')
    expect(await handle.runNow()).toBeNull()

    account.id = 'second'
    expect((await handle.runNow())?.outcome).toBe('claimed')
    handle.stop()
  })
})