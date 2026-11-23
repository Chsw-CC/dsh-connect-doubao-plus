/**
 * Resolve the non-secret identity captured from the official Doubao page.
 *
 * The cookie jar proves an account; these fields prove which browser owns that
 * session. Keeping this small resolver separate lets chat, quota and check-in
 * share one identity without coupling their request logic to browser startup.
 */
import type { BrowserFingerprint } from './doubao-auth-browser.ts'
import { readBrowserFingerprint } from './doubao-auth-browser.ts'

export type DoubaoBrowserFingerprint = Partial<BrowserFingerprint>

let cached: DoubaoBrowserFingerprint | null | undefined

/** Return the last captured page identity, or null when none has been captured. */
export function browserFingerprint(): DoubaoBrowserFingerprint | null {
  if (cached !== undefined) return cached
  cached = readBrowserFingerprint() ?? null
  return cached
}

/** Drop the cached read after a fresh login or fingerprint capture. */
export function invalidateBrowserFingerprint(): void {
  cached = undefined
}
