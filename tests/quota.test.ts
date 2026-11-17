import { describe, expect, it } from 'vitest'

import { findWindow, millisUntilReset, normalizeWindow, remainingTotal, type DoubaoQuota } from '../src/doubao-quota.ts'

/**
 * The payload shapes this account actually receives, captured from the live
 * quota endpoint and read off the Doubao panel.
 *
 * - `window_limit_section` → one monthly window (window_type 4), `start_time` 0
 *   and a real `end_time` ~8.75 days out — opens on first use, resets later.
 *   (Older plan shapes reported window_type 1/2 with both timestamps 0; those
 *   types are no longer modeled, and the window below pins the current shape.)
 * - `incentive_quota_section` → the 「活动赠送额度」 grant: 782 of 1,600 used,
 *   an `end_time` (11月21日 09:46) but no `start_time`.
 *
 * The old normalizer only read the first section (so the grant being consumed
 * was invisible) and invented a reset instant from the nominal window length
 * (so the card counted down to a moment the server never sent).
 */
const MONTHLY = {
  end_time: 1_797_220_000_000,
  start_time: 0,
  item_type: 0,
  less_than_one_percent: false,
  total_amount: '9,000',
  used_amount: '9,000',
  used_percent: 100,
  window_type: 4,
}

/** The package-credit allowance Doubao switched to in 2026-11. */
const PACKAGE_WINDOW = {
  end_time: 1_795_505_409_041,
  start_time: 0,
  item_type: 1,
  less_than_one_percent: false,
  total_amount: '9,000',
  used_amount: '449',
  used_percent: 4,
  window_type: 4,
}

const BONUS_GRANT = {
  end_time: 1_795_225_599_150,
  start_time: 0,
  item_type: 0,
  less_than_one_percent: false,
  total_amount: '1,600',
  used_amount: '782',
  used_percent: 48,
  window_type: 3,
}

function quotaOf(...windows: ReturnType<typeof normalizeWindow>[]): DoubaoQuota {
  return {
    exhausted: false,
    windows: windows.filter((window) => window !== undefined),
    fetchedAt: 1,
  }
}

describe('normalizeWindow', () => {
  it('maps window_type 4 to the monthly window', () => {
    const window = normalizeWindow(MONTHLY)
    expect(window).toBeDefined()
    expect(window?.type).toBe('monthly')
    expect(window?.usedPercent).toBe(100)
    expect(window?.remainingPercent).toBe(0)
    expect(window?.resetsAt).toBe(MONTHLY.end_time)
    // start_time 0 means "opens on first use": the expiry is real.
    expect(window?.startsOnUse).toBe(true)
    expect(window?.startedAt).toBe(0)
  })

  it('keeps counting down from a real expiry even when the start is missing', () => {
    const window = normalizeWindow(MONTHLY)
    expect(millisUntilReset(window!, MONTHLY.end_time - 1_000)).toBe(1_000)
  })

  it('reads the promotional grant, with its expiry but no start', () => {
    const window = normalizeWindow(BONUS_GRANT, '活动赠送额度')
    expect(window?.type).toBe('incentive')
    expect(window?.label).toBe('活动赠送额度')
    expect(window?.usedPercent).toBe(48)
    expect(window?.usedAmount).toBe(782)
    expect(window?.totalAmount).toBe(1600)
    // The expiry IS real: only the opening instant is missing.
    expect(window?.resetUnknown).toBeUndefined()
    expect(window?.startsOnUse).toBe(true)
    expect(window?.resetsAt).toBe(BONUS_GRANT.end_time)
    expect(window?.windowMs).toBe(0)
    expect(millisUntilReset(window!, 1_000)).toBe(BONUS_GRANT.end_time - 1_000)
  })

  it('parses the formatted amounts', () => {
    const window = normalizeWindow(MONTHLY)
    expect(window?.usedAmount).toBe(9000)
    expect(window?.totalAmount).toBe(9000)
  })

  it('derives the percentage from amounts when used_percent is absent', () => {
    const window = normalizeWindow({ ...BONUS_GRANT, used_percent: undefined, used_amount: '800' })
    expect(window?.usedPercent).toBeCloseTo(50)
    expect(window?.remainingPercent).toBeCloseTo(50)
  })

  it('prefers a reported used_percent over the amounts', () => {
    const window = normalizeWindow({ ...BONUS_GRANT, used_percent: 12, used_amount: '800' })
    expect(window?.usedPercent).toBe(12)
  })

  it('clamps a percentage derived from amounts into 0-100', () => {
    const window = normalizeWindow({ ...BONUS_GRANT, used_percent: undefined, used_amount: '9,999' })
    expect(window?.usedPercent).toBe(100)
  })

  it('keeps the reported window when both timestamps are real', () => {
    const start = 1_000
    const end = 604_801_000
    const window = normalizeWindow({ ...MONTHLY, start_time: start, end_time: end })
    expect(window?.resetUnknown).toBeUndefined()
    expect(window?.startsOnUse).toBeUndefined()
    expect(window?.resetsAt).toBe(end)
    expect(window?.startedAt).toBe(start)
    expect(window?.windowMs).toBe(end - start)
    expect(millisUntilReset(window!, 2_000)).toBe(end - 2_000)
  })

  it('maps the package-credit window that replaced the rolling limits', () => {
    const window = normalizeWindow(PACKAGE_WINDOW)
    // The fork calls the window_type 4 bucket `monthly`; the payload is the same
    // package-credit allowance upstream labels `package`.
    expect(window?.type).toBe('monthly')
    expect(window?.windowType).toBe(4)
    expect(window?.usedAmount).toBe(449)
    expect(window?.totalAmount).toBe(9000)
    expect(window?.usedPercent).toBe(4)
    // Only an expiry is sent: the window bills from first use.
    expect(window?.resetsAt).toBe(PACKAGE_WINDOW.end_time)
    expect(millisUntilReset(window!, 1_000)).toBe(PACKAGE_WINDOW.end_time - 1_000)
  })

  it('ignores window types it does not model', () => {
    // window_type 1/2 were modeled until 2026-11-16; they must stay unmapped.
    expect(normalizeWindow({ ...MONTHLY, window_type: 9 })).toBeUndefined()
    expect(normalizeWindow({ ...MONTHLY, window_type: 1 })).toBeUndefined()
    expect(normalizeWindow({ ...MONTHLY, window_type: 2 })).toBeUndefined()
  })
})

describe('findWindow', () => {
  it('reports a missing five-hour bucket as undefined, not as zero usage', () => {
    const quota = quotaOf(normalizeWindow(MONTHLY), normalizeWindow(BONUS_GRANT, '活动赠送额度'))
    expect(findWindow(quota, 'monthly')?.totalAmount).toBe(9000)
    // legacy bucket names are gone from the model entirely
    expect(normalizeWindow({ ...MONTHLY, window_type: 1 })).toBeUndefined()
  })

  it('finds the package-credit window and the grant side by side', () => {
    const quota = quotaOf(normalizeWindow(PACKAGE_WINDOW), normalizeWindow(BONUS_GRANT, '活动赠送额度'))
    expect(findWindow(quota, 'monthly')?.totalAmount).toBe(9000)
    expect(findWindow(quota, 'incentive')?.usedAmount).toBe(782)
    // No 5-hour bucket in this account shape.
    expect(findWindow(quota, 'five_hour')).toBeUndefined()
  })

  it('finds the promotional grant in the same list', () => {
    const quota = quotaOf(normalizeWindow(MONTHLY), normalizeWindow(BONUS_GRANT, '活动赠送额度'))
    const grant = findWindow(quota, 'incentive')
    expect(grant?.usedAmount).toBe(782)
    expect(grant?.label).toBe('活动赠送额度')
  })
})

describe('remainingTotal', () => {
  it('sums what is left across the package window and the grant', () => {
    const quota = quotaOf(normalizeWindow(PACKAGE_WINDOW), normalizeWindow(BONUS_GRANT, '活动赠送额度'))
    // 9,000 - 449 package credits plus 1,600 - 782 grant credits.
    expect(remainingTotal(quota)).toBe(9_369)
  })

  it('returns null when no window reports amounts', () => {
    const quota = quotaOf(normalizeWindow({ ...MONTHLY, used_amount: undefined, total_amount: undefined }))
    expect(remainingTotal(quota)).toBeNull()
  })
})