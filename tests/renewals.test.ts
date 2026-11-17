/**
 * Rotated cookies are half a credential, and both halves must be dropped
 * together.
 *
 * Doubao hands back `x-ms-token` / `set-cookie` values on ordinary responses, so
 * the shim remembers them and overlays them onto the next request's `Cookie:`
 * header. That memory OUTLIVES a login: nothing used to clear it, which meant
 * the first request after a fresh QR scan carried the previous session's rotated
 * cookies on top of the new ones — a session the server reads as still dead, and
 * the user sees "signed in" in the card while every turn is rejected.
 *
 * `invalidateRenewals` already documented the rule; these cases pin the
 * behaviour it promises so the two call sites (revoke-on-session-dead and
 * successful re-login) can rely on it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyRenewals,
  buildHeaders,
  invalidateRenewals,
  stopGeneration,
  type DoubaoCredentials,
} from '../src/doubao-upstream.ts'
import { REQUIRED_COOKIE_NAMES } from '../src/doubao-auth.ts'

function session(cookieHeader: string): DoubaoCredentials {
  const pairs = new Map<string, string>()
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== undefined && rest.length > 0) pairs.set(name, rest.join('='))
  }
  return { ok: true, header: cookieHeader, pairs }
}

const OLD_SESSION = REQUIRED_COOKIE_NAMES.map((name) => `${name}=old`).join('; ')
const NEW_SESSION = REQUIRED_COOKIE_NAMES.map((name) => `${name}=new`).join('; ')

afterEach(() => {
  invalidateRenewals()
  vi.unstubAllGlobals()
})

describe('rotated cookies', () => {
  it('overlays a rotated value onto the header, then forgets it on invalidateRenewals', async () => {
    // Any response can rotate cookies; `stopGeneration` is the shortest reachable
    // path to `absorbSetCookies` that does not need a live stream.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status_code: 0 }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ms-token': 'rotated-ms-token',
          'set-cookie': 'ttwid=rotated-ttwid; Path=/; Domain=.doubao.com',
        },
      },
    )))

    await stopGeneration(session(OLD_SESSION), { conversationId: 'c', questionId: 'q' })
    const withRotation = buildHeaders(session(OLD_SESSION)).cookie
    expect(withRotation).toContain('ttwid=rotated-ttwid')
    expect(withRotation).toContain('msToken=rotated-ms-token')

    invalidateRenewals()

    // Exactly the caller's header again: no rotated value survives.
    expect(buildHeaders(session(OLD_SESSION)).cookie).toBe(OLD_SESSION)
    expect(applyRenewals(NEW_SESSION)).toBe(NEW_SESSION)
  })

  it('is what makes a re-login effective: a stale rotation never touches the new session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status_code: 0 }),
      { status: 200, headers: { 'set-cookie': 'sessionid=dead-session; Path=/' } },
    )))
    await stopGeneration(session(OLD_SESSION), { conversationId: 'c', questionId: 'q' })

    // Without the drop, the fresh scan would be overlaid with `sessionid=dead-session`.
    expect(buildHeaders(session(NEW_SESSION)).cookie).toContain('sessionid=dead-session')

    invalidateRenewals()

    const fresh = buildHeaders(session(NEW_SESSION)).cookie
    expect(fresh).toBe(NEW_SESSION)
    expect(fresh).not.toContain('dead-session')
  })
})
