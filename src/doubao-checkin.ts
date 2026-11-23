/**
 * Doubao daily check-in (每日签到, +200 quota) and its once-a-day scheduler.
 *
 * Two upstream calls, both POST, both plain cookie auth:
 *
 *   POST /alice/ug/campaign/v3/detail/       read the task panel
 *   POST /alice/ug/campaign/landing/checkin  claim; idempotent server-side
 *
 * Verified 2026-11-17 against a live account with this plugin's own sealed
 * session: the panel answered code 0 with checked_in_today true, streak 27,
 * reward 200; a REPLAYED claim answered idempotent true and reward_amount 200
 * without granting a second time. That idempotency is what makes running the
 * claim on a scheduler safe -- the worst case for a redundant attempt is a
 * no-op, never a double grant.
 *
 * THE PARAM SET IS NOT THE CHAT ONE. These endpoints belong to the PC web
 * activity surface: aid 497858 (the chat surface uses 582478) plus the
 * doubao_pc_version pair. Sent the chat parameter set they answer HTTP 200
 * with code 1 and an EMPTY body -- a success-shaped failure that reads as
 * "no activity" rather than as a bug. Only the query differs; the headers are
 * shared, and buildHeaders() goes through verbatim.
 *
 * NOTHING HERE THROWS. Check-in is a bonus, never the product: an endpoint that
 * moves or renames a field must degrade to one quiet line in the card while
 * chat, image generation and the quota panel keep working.
 *
 * @module dsh-connect-doubao-plus/checkin
 */
import { createHash } from 'node:crypto'

import { loadDoubaoCredentials } from './doubao-auth.ts'
import { buildHeaders } from './doubao-upstream.ts'

export const CHECKIN_ORIGIN = 'https://www.doubao.com'

/** Panel read: today's state, the streak and the lifetime total. */
export const CHECKIN_DETAIL_ENDPOINT = `${CHECKIN_ORIGIN}/alice/ug/campaign/v3/detail/`

/** Claim. Idempotent server-side: a replay answers idempotent true. */
export const CHECKIN_CLAIM_ENDPOINT = `${CHECKIN_ORIGIN}/alice/ug/campaign/landing/checkin`

/** Campaign group this client is enrolled in; the claim carries it as scene. */
export const CHECKIN_CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3'

/** Ceiling on one check-in call, in ms. It is a bonus; it never owns the turn. */
export const CHECKIN_REQUEST_TIMEOUT_MS = 15_000

/** How long a panel read is reused, in ms. */
export const CHECKIN_STATUS_TTL_MS = 60_000

/** How often the scheduler looks at the clock, in ms. Cheap: the key is local. */
export const CHECKIN_TICK_MS = 10 * 60 * 1000

/** First look after startup, in ms, so a host booted at noon still claims today. */
export const CHECKIN_FIRST_TICK_MS = 45 * 1000

/**
 * Non-secret PC-web activity identity.
 *
 * NOT the chat surface's `CLIENT_PARAMS`: `aid` must be 497858 there is no
 * `client_platform`, and `doubao_device_platform` is `web` rather than
 * `desktop`. Verified on 2026-11-17 -- the chat set answers `code: 1` with an
 * empty body on the same cookie, this set answers the panel.
 *
 * The empty `device_id` / `region` / `sys_region` are part of the shape, not an
 * omission: filling them in with the desktop ids made the panel answer `code: 2`.
 */
const CAMPAIGN_PARAMS: Readonly<Record<string, string>> = {
  version_code: '20800',
  language: 'zh',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  pc_version: '2.32.6',
  doubao_pc_version: '5.72.66',
  samantha_web: '1',
  web_platform: 'desktop',
  'use-olympus-account': '1',
  web_tab_id: '0',
  web_id: '7677868049198630415',
  tea_uuid: '2697515174213273',
  device_id: '',
  region: '',
  sys_region: '',
}

/** "This cookie is dead" -- distinct from "this account has no such task". */
const CODE_LOGIN_INVALID = 710012001

/**
 * 710010702 is TWO different answers depending on which endpoint says it.
 *
 *   detail -> "这个账号没有每日签到活动" (the work / Feishu account shape): real.
 *   claim  -> "系统错误" (upstream's own wording): transient, nothing was granted.
 *
 * Treating the claim refusal as "no activity" is what silently marked a healthy
 * account as settled for the whole day: the panel kept showing an unclaimed day
 * while the scheduler had already gone quiet. Only the detail read may conclude
 * "no activity"; the claim refusal must stay retryable.
 */
const CODE_NO_ACTIVITY = 710010702

/** How long a refused claim is left alone before it is retried, in ms. */
export const CHECKIN_REFUSAL_COOLDOWN_MS = 60 * 60 * 1000

/** What the card shows. Every value is produced here; nothing is passed through. */
export type DoubaoCheckinOutcome =
  /** Just claimed: the +200 landed on this call. */
  | 'claimed'
  /** Already claimed today -- by the user, an earlier attempt, or the scheduler. */
  | 'already'
  /**
   * Panel read fine, today's grant is still unclaimed. NOT a failure: the button
   * has work to do. Collapsing this into 'failed' made every healthy account look
   * broken in the card and made a transient error indistinguishable from "正常待领取".
   */
  | 'ready'
  /**
   * The panel is readable but upstream refused the claim for now (「系统错误」).
   * Distinct from 'no_task' (no activity exists) and from 'failed' (transport):
   * retrying immediately is what upstream asked us not to do, so the scheduler
   * backs off instead of hammering, and the card stays honest about the panel.
   */
  | 'inactive'
  /** The session is gone. Only a fresh QR sign-in fixes it; retrying cannot. */
  | 'needs_login'
  /** Signed in, but this account has no check-in activity (work / Feishu account). */
  | 'no_task'
  /** Not claimable right now, or anything else went wrong. */
  | 'failed'

/** One reading of the check-in panel. Numbers and an enum, never a credential. */
export interface DoubaoCheckinView {
  ok: boolean
  outcome: DoubaoCheckinOutcome
  /** Consecutive days claimed, as the panel reports them. */
  continuousDays: number | null
  /** True once today's grant has landed; null when the panel could not be read. */
  checkedInToday: boolean | null
  /** The day's grant -- a quota amount, not a currency. */
  rewardAmount: number | null
  /** `quota_grant` today; kept as text because the panel may add kinds. */
  rewardType: string | null
  /** Lifetime total the panel shows above the streak. */
  totalAmount: number | null
  /** Beijing day this reading describes, `YYYY-MM-DD`. */
  day: string
  /** Epoch ms of this read. */
  fetchedAt: number
  /** Short non-secret reason for `failed` / `needs_login`, else null. */
  error: string | null
}

/* ------------------------------------------------------------------ *
 * Day boundary
 * ------------------------------------------------------------------ */

/**
 * Beijing is the account's day boundary, so it is the scheduler's too.
 *
 * Computed from the UTC epoch by shifting it and reading the UTC date back: that
 * is correct for every instant, with no DST table and no `Intl` locale
 * dependency (a host is free to run with a trimmed ICU).
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export function beijingDayKey(now: number = Date.now()): string {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

function campaignQueryUrl(endpoint: string): string {
  const params = new URLSearchParams(CAMPAIGN_PARAMS)
  return `${endpoint}?${params.toString()}`
}

/**
 * Read a field that arrives as a number OR a formatted string.
 *
 * The panel formats some amounts for display ("10,550") and sends others raw. A
 * parse that only handled one shape would report the streak -- or the grant --
 * as null while the data was right there.
 */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

type CampaignReply =
  | { kind: 'json'; body: Record<string, unknown> }
  /** Missing credentials, code 710012001, or HTTP 401/403: one fix, one message. */
  | { kind: 'needs_login'; error: string }
  /** The cookie works but the account has no such activity. */
  | { kind: 'no_task'; error: string }
  /** Cookie fine, activity exists, upstream declined this particular claim. */
  | { kind: 'refused'; error: string }
  | { kind: 'failed'; error: string }

/**
 * POST one campaign call.
 *
 * Never throws: every failure mode is a value the card can render, because the
 * alternative -- an exception -- trips the card's error boundary and blanks the
 * whole slot over a bonus nobody asked for.
 */
async function postCampaign(
  endpoint: string,
  body: Readonly<Record<string, unknown>>,
): Promise<CampaignReply> {
  const credentials = loadDoubaoCredentials()
  if (!credentials.ok) {
    return {
      kind: 'needs_login',
      error: credentials.reason ?? '还没有浏览器登录态。请在豆包卡片里点「重新登录」扫码一次。',
    }
  }

  let response: Response
  try {
    response = await fetch(campaignQueryUrl(endpoint), {
      method: 'POST',
      headers: buildHeaders(credentials, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHECKIN_REQUEST_TIMEOUT_MS),
    })
  } catch (error: unknown) {
    const name = (error as { name?: unknown }).name
    const message = name === 'TimeoutError' || name === 'AbortError'
      ? `豆包签到接口 ${String(Math.round(CHECKIN_REQUEST_TIMEOUT_MS / 1000))} 秒未响应`
      : String((error as Error)?.message ?? 'network error')
    return { kind: 'failed', error: message.slice(0, 160) }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'needs_login',
      error: `豆包拒绝了这次签到请求（HTTP ${String(response.status)}），请重新扫码登录`,
    }
  }
  if (!response.ok) {
    return { kind: 'failed', error: `豆包签到接口 HTTP ${String(response.status)}` }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { kind: 'failed', error: '豆包签到接口返回的不是 JSON' }
  }
  if (payload === null || typeof payload !== 'object') {
    return { kind: 'failed', error: '豆包签到接口返回了意外的结构' }
  }

  const envelope = payload as { code?: unknown; msg?: unknown; message?: unknown; data?: unknown }
  const code = numberOf(envelope.code)
  if (code === CODE_LOGIN_INVALID) {
    return { kind: 'needs_login', error: '豆包登录已过期，请重新扫码登录一次' }
  }
  if (code === CODE_NO_ACTIVITY) {
    // Only the panel read may conclude "this account has no activity". On the
    // CLAIM endpoint the same code is upstream's 「系统错误」 -- nothing was
    // granted, and reporting it as no_task would settle the day for an account
    // that plainly has one. Keep it retryable.
    if (endpoint === CHECKIN_CLAIM_ENDPOINT) {
      return { kind: 'refused', error: '豆包签到接口返回 710010702（系统错误），稍后自动重试' }
    }
    return { kind: 'no_task', error: '这个豆包账号没有每日签到活动（企业 / 飞书账号没有这个玩法）' }
  }
  if (code !== 0) {
    const hint = textOf(envelope.msg) ?? textOf(envelope.message) ?? ''
    return {
      kind: 'failed',
      error: `豆包签到接口返回异常：${hint === '' ? '无错误信息' : hint}（code ${String(code ?? '?')}）`,
    }
  }
  const data = envelope.data
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return { kind: 'json', body: record }
}

/* ------------------------------------------------------------------ *
 * Panel parsing
 * ------------------------------------------------------------------ */

/**
 * Task kinds that mean "the daily check-in".
 *
 * Two spellings are accepted because the panel is the only place that names it
 * and a rename upstream must not read as "this account has no check-in" -- the
 * one answer that would make the card hide the button forever with no error.
 */
const DAILY_TASK_KINDS = new Set(['daily_signin', 'daily_checkin'])

interface RawDaily {
  checked_in_today?: unknown
  continuous_days?: unknown
  last_checkin_date?: unknown
  reward?: unknown
}

function dailyOf(body: Record<string, unknown>): RawDaily | undefined {
  const tasks = Array.isArray(body.tasks) ? body.tasks : []
  for (const entry of tasks) {
    if (entry === null || typeof entry !== 'object') continue
    const task = entry as { task_kind?: unknown; daily_checkin?: unknown; daily_signin?: unknown }
    if (typeof task.task_kind !== 'string' || !DAILY_TASK_KINDS.has(task.task_kind)) continue
    const daily = task.daily_checkin ?? task.daily_signin
    if (daily !== null && daily !== undefined && typeof daily === 'object') return daily as RawDaily
    // A daily task with no nested block still exists; report it as not claimed.
    return {}
  }
  return undefined
}

function rewardOf(daily: RawDaily): { amount: number | null; type: string | null } {
  const reward = daily.reward
  if (reward === null || reward === undefined || typeof reward !== 'object') {
    return { amount: null, type: null }
  }
  const value = reward as { reward_amount?: unknown; reward_type?: unknown }
  return { amount: numberOf(value.reward_amount), type: textOf(value.reward_type) }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

interface AccountCheckinState {
  cached?: DoubaoCheckinView | undefined
  /** The Beijing day whose grant we already know landed: a status read stays local. */
  claimedDay?: string | undefined
  /** The read on the wire, shared by every caller that asks meanwhile. */
  inFlight?: Promise<DoubaoCheckinView> | undefined
  /**
   * Epoch ms of the last REFUSED claim, if any.
   *
   * Per account on purpose. A shared refusal instant lets one restricted account
   * silence every other account on the host.
   */
  refusedAt?: number | undefined
}

const states = new Map<string, AccountCheckinState>()

/**
 * Which account a piece of state belongs to, derived from the live session.
 *
 * The id is hashed rather than stored: nothing here should name an account, and a
 * re-login of the SAME account must keep its settled day. With no session there is
 * no account, and the shared bucket is correct -- every such caller answers
 * needs_login anyway.
 */
function accountStateKey(): string {
  const credentials = loadDoubaoCredentials()
  const id = credentials.ok
    ? (credentials.pairs.get('uid_tt') ?? credentials.pairs.get('sessionid'))
    : undefined
  if (id === undefined || id === '') return 'anonymous'
  return createHash('sha256').update(id).digest('hex').slice(0, 16)
}

function stateOf(): AccountCheckinState {
  const key = accountStateKey()
  let state = states.get(key)
  if (state === undefined) {
    state = {}
    states.set(key, state)
  }
  return state
}

/** Forget every account's cache. Used by sign-out, the card's claim, and tests. */
export function invalidateCheckinCache(): void {
  states.clear()
}

function view(
  outcome: DoubaoCheckinOutcome,
  day: string,
  extra: Partial<DoubaoCheckinView> = {},
): DoubaoCheckinView {
  return {
    ok: outcome === 'claimed' || outcome === 'already' || outcome === 'ready',
    outcome,
    continuousDays: null,
    checkedInToday: null,
    rewardAmount: null,
    rewardType: null,
    totalAmount: null,
    day,
    fetchedAt: Date.now(),
    error: null,
    ...extra,
  }
}

/** Read the panel. Cached for {@link CHECKIN_STATUS_TTL_MS} unless `force`. */
export async function readDoubaoCheckin(
  options: { force?: boolean } = {},
): Promise<DoubaoCheckinView> {
  const now = Date.now()
  const day = beijingDayKey(now)

  // A grant this process landed itself needs no confirmation for the rest of the
  // day: the server is idempotent, so re-reading could only agree.
  const state = stateOf()
  if (options.force !== true && state.claimedDay === day && state.cached !== undefined) return state.cached
  if (
    options.force !== true
    && state.cached !== undefined
    && now - state.cached.fetchedAt < CHECKIN_STATUS_TTL_MS
  ) {
    return state.cached
  }
  if (state.inFlight !== undefined) return state.inFlight

  const run = (async (): Promise<DoubaoCheckinView> => {
    const reply = await postCampaign(CHECKIN_DETAIL_ENDPOINT, {
      campaign_group_code: CHECKIN_CAMPAIGN_GROUP,
    })
    if (reply.kind === 'needs_login') return view('needs_login', day, { error: reply.error })
    if (reply.kind === 'no_task') return view('no_task', day, { error: reply.error })
    if (reply.kind === 'failed') return view('failed', day, { error: reply.error })
    // A refusal is only ever produced for the claim endpoint, so it cannot reach
    // here; narrowing it keeps the body access total.
    if (reply.kind === 'refused') return view('failed', day, { error: reply.error })

    const daily = dailyOf(reply.body)
    if (daily === undefined) {
      return view('no_task', day, {
        error: '豆包账号里没有「每日签到」任务（企业 / 飞书账号没有这个玩法）',
      })
    }
    const reward = rewardOf(daily)
    const checkedInToday = daily.checked_in_today === true
    const progress = reply.body.progress
    return view(checkedInToday ? 'already' : 'ready', day, {
      continuousDays: numberOf(daily.continuous_days),
      checkedInToday,
      rewardAmount: reward.amount,
      rewardType: reward.type,
      totalAmount: numberOf(progress !== null && typeof progress === 'object' ? (progress as { total_amount?: unknown }).total_amount : undefined),
      // An unclaimed day is a normal, healthy state -- 'ready' is ok, so it carries
      // no error line. The card's button already says 领取.
      error: null,
    })
  })()

  state.inFlight = run
  try {
    const result = await run
    // Only a SUCCESSFUL read is worth memoising: caching a failure would pin
    // "needs login" or "no activity" for a minute after the user fixed it, which
    // is the silent-revert shape this plugin has been bitten by before.
    if (result.ok) state.cached = result
    return result
  } finally {
    if (state.inFlight === run) state.inFlight = undefined
  }
}

/**
 * Claim today's grant.
 *
 * The claim is idempotent server-side, so this deliberately does NOT read first:
 * one POST settles it, and a redundant press costs one no-op rather than two
 * round trips per click. The follow-up read is best-effort enrichment (streak,
 * lifetime total) and its failure must not turn a successful claim into an
 * error.
 *
 * A REFUSAL is not a result. Upstream answering 「系统错误」 to the claim says
 * nothing about whether today's grant exists -- the panel is the only authority
 * on that, and it may be read again. Callers that must not hammer pass
 * `{ respectCooldown: true }` (the scheduler does).
 */
export async function claimDoubaoCheckin(
  options: { respectCooldown?: boolean } = {},
): Promise<DoubaoCheckinView> {
  const day = beijingDayKey()
  const state = stateOf()
  if (
    options.respectCooldown === true
    && state.refusedAt !== undefined
    && Date.now() - state.refusedAt < CHECKIN_REFUSAL_COOLDOWN_MS
  ) {
    return view('inactive', day, {
      checkedInToday: false,
      error: `豆包刚刚拒绝了领取，冷却中，稍后自动再试（北京时间 ${day}）`,
    })
  }

  const reply = await postCampaign(CHECKIN_CLAIM_ENDPOINT, { scene: CHECKIN_CAMPAIGN_GROUP })
  if (reply.kind === 'needs_login') return view('needs_login', day, { error: reply.error })
  if (reply.kind === 'no_task') return view('no_task', day, { error: reply.error })
  if (reply.kind === 'failed') return view('failed', day, { error: reply.error })
  if (reply.kind === 'refused') {
    // Remember WHEN, not "never": the cooldown belongs to this account alone, and
    // the attempt after it is allowed to succeed.
    state.refusedAt = Date.now()
    return view('inactive', day, { checkedInToday: false, error: reply.error })
  }

  const outcome: DoubaoCheckinOutcome = reply.body.idempotent === true ? 'already' : 'claimed'
  const granted = numberOf(reply.body.reward_amount)

  const enriched = await readDoubaoCheckin({ force: true })
    .then((fresh) => (fresh.checkedInToday === null ? undefined : fresh))
    .catch(() => undefined)

  const result = view(outcome, day, {
    continuousDays: enriched?.continuousDays ?? null,
    checkedInToday: true,
    rewardAmount: granted ?? enriched?.rewardAmount ?? null,
    rewardType: enriched?.rewardType ?? 'quota_grant',
    totalAmount: enriched?.totalAmount ?? null,
  })
  state.cached = result
  if (result.ok) state.claimedDay = day
  return result
}

/* ------------------------------------------------------------------ *
 * Once-a-day scheduler
 * ------------------------------------------------------------------ */

export interface DoubaoAutoCheckinHandle {
  /** Stop the timer. Safe to call twice. */
  stop(): void
  /** Run one sweep now, regardless of the tick. Returns null when skipped. */
  runNow(): Promise<DoubaoCheckinView | null>
}

/**
 * Claim once per Beijing day, while enabled.
 *
 * The scheduler keeps NO on-disk "done today" flag, on purpose: the panel itself
 * says whether today is claimed, so a restart mid-day simply looks again and
 * finds either a job to do or `already`. Persisting the flag would add a second
 * source of truth that is wrong in exactly the case that matters -- a day having
 * rolled over while the host was off.
 *
 * Skips are outcomes, not silence:
 *   - disabled       -> no request at all
 *   - settled today  -> claimed / already / needs_login / no_task are not retried
 *   - failed         -> RETRIED on the next tick, because that is usually transient
 *   - inactive       -> RETRIED after CHECKIN_REFUSAL_COOLDOWN_MS, because a refusal
 *                       says nothing about whether the grant exists
 *   - ready          -> RETRIED on the next tick, because the grant is still there
 *
 * Settlement is PER ACCOUNT. Signing in as a second account used to inherit the
 * first account's "done today" and silently skip its claim -- a missing reward,
 * not a cosmetic bug.
 *
 * `needs_login` is deliberately settled: no amount of retrying mints a session,
 * and an hourly failure would only bury the one message that tells the user what
 * to do.
 */
export function startDoubaoAutoCheckin(deps: {
  enabled: () => boolean
  onResult?: (view: DoubaoCheckinView) => void
  tickMs?: number
  firstTickMs?: number
}): DoubaoAutoCheckinHandle {
  const tickMs = deps.tickMs ?? CHECKIN_TICK_MS
  const firstTickMs = deps.firstTickMs ?? CHECKIN_FIRST_TICK_MS
  /** Account key -> Beijing day that account is done with. */
  const settled = new Map<string, string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const sweep = async (): Promise<DoubaoCheckinView | null> => {
    if (stopped) return null
    if (!deps.enabled()) return null
    const day = beijingDayKey()
    const account = accountStateKey()
    if (settled.get(account) === day) return null

    const result = await claimDoubaoCheckin({ respectCooldown: true }).catch(
      () => view('failed', day, { error: 'claim threw' }),
    )
    deps.onResult?.(result)
    // Only a landed grant settles the day. 'failed' is a transport blip,
    // 'ready' means the grant is still unclaimed, and 'inactive' is an upstream
    // refusal -- all three are retried, 'inactive' behind its cooldown.
    if (result.outcome !== 'failed' && result.outcome !== 'ready' && result.outcome !== 'inactive') {
      settled.set(account, day)
    }
    return result
  }

  const schedule = (delay: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void sweep().finally(() => schedule(tickMs))
    }, delay)
    timer.unref?.()
  }
  schedule(firstTickMs)

  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
    runNow: sweep,
  }
}