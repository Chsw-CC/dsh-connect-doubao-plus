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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadDoubaoCredentials } from './doubao-auth.ts'
import { buildHeaders } from './doubao-upstream.ts'

export const CHECKIN_ORIGIN = 'https://www.doubao.com'

/** Name of the file under `~/.dsh` that remembers the last claim outcome. */
const CHECKIN_STATE_FILENAME = 'dsh-connect-doubao.checkin.json'

/** Every outcome the card and the scheduler understand; a state file gate. */
const CHECKIN_OUTCOMES: ReadonlySet<string> = new Set<string>([
  'claimed',
  'already',
  'ready',
  'needs_login',
  'no_task',
  'inactive',
  'failed',
])

/** Panel read: today's state, the streak and the lifetime total. */
export const CHECKIN_DETAIL_ENDPOINT = `${CHECKIN_ORIGIN}/alice/ug/campaign/v3/detail/`

/** Claim. Idempotent server-side: a replay answers idempotent true. */
export const CHECKIN_CLAIM_ENDPOINT = `${CHECKIN_ORIGIN}/alice/ug/campaign/landing/checkin`

/** Campaign group this client is enrolled in; the claim carries it as scene. */
export const CHECKIN_CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3'

/**
 * Campaign groups to fall back through, in order.
 *
 * The group id is the one part of this surface that changes when Doubao reshuffles
 * the activity: a renamed group answers `code: 0` with no daily task, which is
 * indistinguishable from "this account has no check-in" unless we try the older
 * spellings too. The first group that yields a daily task is remembered for the
 * claim and for later reads.
 */
export const CHECKIN_CAMPAIGN_GROUPS: readonly string[] = [
  CHECKIN_CAMPAIGN_GROUP,
  'pc_incentive_task_mvp_v2',
  'pc_incentive_task_mvp',
]

/** Group that answered with a daily task last; scoped to the current session. */
let campaignGroup = CHECKIN_CAMPAIGN_GROUPS[0]

/** Ceiling on one check-in call, in ms. It is a bonus; it never owns the turn. */
export const CHECKIN_REQUEST_TIMEOUT_MS = 15_000

/** How long a panel read is reused, in ms. */
export const CHECKIN_STATUS_TTL_MS = 60_000

/** How often the scheduler looks at the clock, in ms. Cheap: the key is local. */
export const CHECKIN_TICK_MS = 10 * 60 * 1000

/** First look after startup, in ms, so a host booted at noon still claims today. */
export const CHECKIN_FIRST_TICK_MS = 45 * 1000

/**
 * How long a refused claim is left alone, in ms.
 *
 * `channel-pack` throttles a repeated check-in the same way (TRAE answers 9074
 * with a 300s cooldown, the shared scheduler retries no sooner than an hour).
 * The point is not patience -- it is that hammering an endpoint which has
 * already answered "no" cannot change the answer and does bury the log.
 */
export const CHECKIN_REFUSED_COOLDOWN_MS = 60 * 60 * 1000

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

/** "Cookie is fine, nothing claimable here" -- the work / Feishu account shape. */
const CODE_NO_ACTIVITY = 710010702

/** What the card shows. Every value is produced here; nothing is passed through. */
export type DoubaoCheckinOutcome =
  /** Just claimed: the +200 landed on this call. */
  | 'claimed'
  /** Already claimed today -- by the user, an earlier attempt, or the scheduler. */
  | 'already'
  /**
   * The panel answered and today's grant is still unclaimed: the ordinary state
   * of a working account at the start of a day. Distinct from 'failed', which is
   * why the card used to show an error before the user had done anything wrong.
   */
  | 'ready'
  /** The session is gone. Only a fresh QR sign-in fixes it; retrying cannot. */
  | 'needs_login'
  /** Signed in, but this account has no check-in activity (work / Feishu account). */
  | 'no_task'
  /**
   * Signed in to a real account, but nothing claimable RIGHT NOW: the panel shows
   * the daily task standing open while the claim endpoint refuses it.
   *
   * This is a normal terminal state, not a fault -- compare `channel-pack`'s
   * LobsterAI (slotState) and Qoder (claimableCampaigns), which both report
   * "nothing to claim" as `inactive` and never as a failure. Retrying inside the
   * hour is pointless, so the scheduler leaves it settled.
   */
  | 'inactive'
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
  /**
   * Epoch ms before which a `failed` claim must not be retried, else null.
   *
   * A transport blip deserves an immediate retry; a refusal repeated eight times
   * does not. Without this the hourly sweep re-asks the same closed door forever.
   */
  retryAfter: number | null
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

function campaignQueryUrl(endpoint: string, pairs?: ReadonlyMap<string, string>): string {
  const params = new URLSearchParams(CAMPAIGN_PARAMS)
  // `web_id` / `tea_uuid` identify the DEVICE, and the constants above came from
  // one machine. When the sealed cookie jar carries its own values, those win:
  // sending another device's ids is the kind of mismatch risk control answers
  // with a bare, unhelpful failure.
  for (const name of ['web_id', 'tea_uuid']) {
    const value = pairs?.get(name)
    if (value !== undefined && value !== '') params.set(name, value)
  }
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
  | { kind: 'no_task'; error: string; code: number }
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
    response = await fetch(campaignQueryUrl(endpoint, credentials.pairs), {
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
    return { kind: 'no_task', code: CODE_NO_ACTIVITY, error: '这个豆包账号没有每日签到活动（企业 / 飞书账号没有这个玩法）' }
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

/**
 * Marks that a task whose name we do not recognise still describes today's
 * check-in. Kept deliberately loose: a rename upstream (`daily_signin_v2`,
 * `check_in`, or a Chinese `每日签到` task name) must not read as "no activity",
 * because that is the one answer which hides the button with no error.
 */
const DAILY_LABEL = /(^daily[_-]?(check|sign)[_-]?in|^check[_-]?in$|^sign[_-]?in$|签到)/i

interface RawDaily {
  checked_in_today?: unknown
  continuous_days?: unknown
  last_checkin_date?: unknown
  reward?: unknown
}

/** Every task-shaped object the panel nests anywhere in `data`. */
function taskEntries(body: Record<string, unknown>, depth = 0): Record<string, unknown>[] {
  if (depth > 3) return []
  const out: Record<string, unknown>[] = []
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value) && /task|list|panel|item/i.test(key)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object') out.push(item as Record<string, unknown>)
      }
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...taskEntries(value as Record<string, unknown>, depth + 1))
    }
  }
  return out
}

function taskLabel(task: Record<string, unknown>): string | undefined {
  for (const key of ['task_kind', 'task_type', 'task_name', 'title', 'name']) {
    const value = task[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** The task-shaped daily block, however the panel spelled it. */
function dailyOf(body: Record<string, unknown>): RawDaily | undefined {
  for (const task of taskEntries(body)) {
    for (const key of ['daily_checkin', 'daily_signin', 'check_in', 'checkin', 'sign_in']) {
      const daily = task[key]
      if (daily !== null && daily !== undefined && typeof daily === 'object') return daily as RawDaily
    }
    if ('checked_in_today' in task || 'continuous_days' in task) return task
    const label = taskLabel(task)
    if (label !== undefined && (DAILY_TASK_KINDS.has(label) || DAILY_LABEL.test(label))) {
      // A daily task with no nested block still exists; report it as not claimed.
      return task
    }
  }
  const nested = body.daily_checkin ?? body.daily_signin
  if (nested !== null && nested !== undefined && typeof nested === 'object') return nested as RawDaily
  return undefined
}

/** Non-secret task labels, for the "no activity" line the card can show. */
function taskKindsOf(body: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  for (const task of taskEntries(body)) {
    const label = taskLabel(task)
    if (label !== undefined && seen.size < 8) seen.add(label.slice(0, 24))
  }
  return [...seen]
}

/**
 * The "no activity" line.
 *
 * When the panel DID answer with tasks but none of them is the daily check-in,
 * naming those tasks is the only way to tell a renamed task from an account that
 * genuinely has no activity -- otherwise both cases read as the same dead end.
 */
function noActivityError(body: Record<string, unknown> | undefined): string {
  const kinds = body === undefined ? [] : taskKindsOf(body)
  return kinds.length === 0
    ? '豆包账号里没有「每日签到」任务（企业 / 飞书账号没有这个玩法）'
    : `豆包账号里没有「每日签到」任务（面板现有任务：${kinds.join('、')}）`
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

let cached: DoubaoCheckinView | undefined
/** The Beijing day whose grant we already know landed: a status read stays local. */
let claimedDay: string | undefined
/** The read on the wire, shared by every caller that asks meanwhile. */
let inFlight: Promise<DoubaoCheckinView> | undefined

/** Forget the cache. Used by the card's claim and by tests. */
export function invalidateCheckinCache(): void {
  cached = undefined
  claimedDay = undefined
  inFlight = undefined
  // The group is discovered per account: a new sign-in must not inherit the
  // previous account's answer.
  campaignGroup = CHECKIN_CAMPAIGN_GROUPS[0]
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
    retryAfter: null,
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
  if (options.force !== true && claimedDay === day && cached !== undefined) return cached
  if (options.force !== true && cached !== undefined && now - cached.fetchedAt < CHECKIN_STATUS_TTL_MS) {
    return cached
  }
  if (inFlight !== undefined) return inFlight

  const run = (async (): Promise<DoubaoCheckinView> => {
    const order = [campaignGroup, ...CHECKIN_CAMPAIGN_GROUPS.filter((group) => group !== campaignGroup)]
    let lastBody: Record<string, unknown> | undefined
    let lastNoTask: string | undefined
    for (const group of order) {
      const reply = await postCampaign(CHECKIN_DETAIL_ENDPOINT, { campaign_group_code: group })
      if (reply.kind === 'needs_login') return view('needs_login', day, { error: reply.error })
      // "No such activity" can be GROUP-specific: a retired v3 with a live v2
      // answers 710010702 too, so it is not proof until every group has said it.
      if (reply.kind === 'no_task') { lastNoTask = reply.error; continue }
      if (reply.kind === 'failed') return view('failed', day, { error: reply.error })

      lastBody = reply.body
      const daily = dailyOf(reply.body)
      if (daily === undefined) continue
      campaignGroup = group
      const reward = rewardOf(daily)
      const checkedInToday = daily.checked_in_today === true
      const progress = reply.body.progress
      return view(checkedInToday ? 'already' : 'ready', day, {
        continuousDays: numberOf(daily.continuous_days),
        checkedInToday,
        rewardAmount: reward.amount,
        rewardType: reward.type,
        totalAmount: numberOf(progress !== null && typeof progress === 'object' ? (progress as { total_amount?: unknown }).total_amount : undefined),
        // "Not claimed yet" is not a failure: the panel simply has nothing to
        // report until the button (or the scheduler) fires.
        error: null,
      })
    }
    return view('no_task', day, { error: lastNoTask ?? noActivityError(lastBody) })
  })()

  inFlight = run
  try {
    const result = await run
    // Only a SUCCESSFUL read is worth memoising: caching a failure would pin
    // "needs login" or "no activity" for a minute after the user fixed it, which
    // is the silent-revert shape this plugin has been bitten by before.
    if (result.ok) cached = result
    return result
  } finally {
    if (inFlight === run) inFlight = undefined
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
 */
export async function claimDoubaoCheckin(
  options: { force?: boolean } = {},
): Promise<DoubaoCheckinView> {
  const day = beijingDayKey()

  // A cooldown survives the process that learned it. Without this read the whole
  // cooldown lasted only as long as the in-memory scheduler, so a restart (or a
  // button press, which does not go through the scheduler at all) re-asked the
  // same closed door immediately -- which is exactly the stampede it exists to
  // stop.
  const remembered = options.force === true ? undefined : readCheckinState()
  if (
    remembered !== undefined &&
    remembered.day === day &&
    remembered.outcome === 'inactive' &&
    remembered.retryAfter !== null &&
    Date.now() < remembered.retryAfter
  ) {
    return view('inactive', day, {
      checkedInToday: remembered.checkedInToday,
      continuousDays: remembered.continuousDays,
      rewardAmount: remembered.rewardAmount,
      retryAfter: remembered.retryAfter,
      error: remembered.error === null ? null : `${remembered.error}（冷却中，稍后自动重试）`,
    })
  }

  const order = [campaignGroup, ...CHECKIN_CAMPAIGN_GROUPS.filter((group) => group !== campaignGroup)]
  let reply: CampaignReply | undefined
  let lastNoTask: string | undefined
  let lastNoTaskCode: number | undefined
  for (const group of order) {
    // Sending the group under both names costs nothing and survives the case
    // where upstream moved the claim from `scene` to `campaign_group_code`.
    const attempt = await postCampaign(CHECKIN_CLAIM_ENDPOINT, {
      scene: group,
      campaign_group_code: group,
    })
    if (attempt.kind === 'needs_login') return view('needs_login', day, { error: attempt.error })
    if (attempt.kind === 'no_task') {
      lastNoTask = attempt.error
      lastNoTaskCode = attempt.code
      continue
    }
    if (attempt.kind === 'failed') return view('failed', day, { error: attempt.error })
    campaignGroup = group
    reply = attempt
    break
  }
  if (reply === undefined || reply.kind !== 'json') {
    // The claim was refused. Before calling that "no activity", check what the
    // PANEL says: measured 2026-11-18, the claim endpoint answered 710010702
    // ("系统错误") while the detail endpoint still reported a live daily task,
    // a 27-day streak and 200 waiting. Reporting "no activity" there is a
    // fabrication that sends the user looking for the wrong fix -- so only say
    // it when the panel actually agrees there is nothing to claim.
    const panel = await readDoubaoCheckin({ force: true })
      .then((fresh) => (fresh.outcome === 'ready' || fresh.outcome === 'already' ? fresh : undefined))
      .catch(() => undefined)
    if (panel === undefined) {
      return view('no_task', day, { error: lastNoTask ?? '豆包账号里没有「每日签到」任务' })
    }
    // The panel says the task is standing and unclaimed; the claim endpoint
    // still refuses. Measured 2026-11-18: 710010702 for every scene spelling, every
    // body shape, with and without an `a_bogus` page signature, eight retries in a
    // row. Reporting that as `failed` is what made the card retry a closed door
    // every ten minutes -- so it is `inactive`, terminal for the day, with the
    // refusal reason kept for the user to read.
    const refused = view('inactive', day, {
      checkedInToday: false,
      retryAfter: Date.now() + CHECKIN_REFUSED_COOLDOWN_MS,
      error: `签到接口拒绝了这次领取（code ${String(lastNoTaskCode ?? CODE_NO_ACTIVITY)}），但面板显示任务仍在、今天尚未领取。不是账号没有活动，是上游这一步没放行。`,
    })
    writeCheckinState({
      day,
      outcome: refused.outcome,
      checkedInToday: refused.checkedInToday,
      continuousDays: refused.continuousDays,
      rewardAmount: refused.rewardAmount,
      retryAfter: refused.retryAfter,
      error: refused.error,
      at: Date.now(),
    })
    return refused
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
  cached = result
  if (result.ok) claimedDay = day
  // The card is often closed right after a claim, so the answer the user wants
  // tomorrow ("did it land, and what did it give?") is written where a restart
  // can still find it. Best effort: a read-only home must not fail the claim.
  writeCheckinState({
    day,
    outcome: result.outcome,
    checkedInToday: result.checkedInToday,
    continuousDays: result.continuousDays,
    rewardAmount: result.rewardAmount,
    retryAfter: result.retryAfter,
    error: result.error,
    at: Date.now(),
  })
  return result
}

/* ------------------------------------------------------------------ *
 * Persisted last result
 * ------------------------------------------------------------------ */

/** Where the last claim result is remembered across host restarts. */
export function checkinStateFilePath(): string {
  // Overridable so the test suite never reads or writes the real cache: a
  // cooldown leaked from one test run would otherwise silence the next one,
  // and a test run would otherwise silence the card.
  const override = process.env.DSH_DOUBAO_CHECKIN_STATE
  if (typeof override === 'string' && override !== '') return override
  return join(homedir(), '.dsh', CHECKIN_STATE_FILENAME)
}

/** What survives a restart: the day, its outcome and the refusal cooldown. */
export interface DoubaoCheckinState {
  day: string
  outcome: DoubaoCheckinOutcome
  checkedInToday: boolean | null
  continuousDays: number | null
  rewardAmount: number | null
  retryAfter: number | null
  error: string | null
  at: number
}

/**
 * Read the remembered state, or undefined.
 *
 * Never throws: this file is a convenience, and a plugin that failed to load its
 * card because a cache was half-written would be trading a bonus for the product.
 */
export function readCheckinState(): DoubaoCheckinState | undefined {
  try {
    const raw = readFileSync(checkinStateFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DoubaoCheckinState>
    if (typeof parsed.day !== 'string' || typeof parsed.outcome !== 'string') return undefined
    const outcome = parsed.outcome as DoubaoCheckinOutcome
    if (!CHECKIN_OUTCOMES.has(outcome)) return undefined
    return {
      day: parsed.day,
      outcome,
      checkedInToday: typeof parsed.checkedInToday === 'boolean' ? parsed.checkedInToday : null,
      continuousDays: numberOf(parsed.continuousDays),
      rewardAmount: numberOf(parsed.rewardAmount),
      retryAfter: numberOf(parsed.retryAfter),
      error: typeof parsed.error === 'string' ? parsed.error.slice(0, 200) : null,
      at: numberOf(parsed.at) ?? 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Remember today's outcome.
 *
 * Atomic (write-temp-then-rename) for the same reason the settings file is: the
 * host may be killed mid-write, and a truncated JSON cache must never be the
 * thing that decides whether a claim runs.
 */
export function writeCheckinState(state: DoubaoCheckinState): void {
  const path = checkinStateFilePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(`${path}.tmp`, path)
  } catch {
    // Best effort: the in-memory cooldown still holds for this process.
  }
}

/* ------------------------------------------------------------------ *
 * Once-a-day scheduler
 * ------------------------------------------------------------------ */

export interface DoubaoAutoCheckinHandle {
  /** Stop the timer. Safe to call twice. */
  stop(): void
  /** Run one sweep now, regardless of the tick. Returns null when skipped. */
  runNow(): Promise<DoubaoCheckinView | null>
  /** The last view the sweep produced, or undefined before the first one. */
  last(): DoubaoCheckinView | undefined
}

/**
 * Claim once per Beijing day, while enabled.
 *
 * The scheduler keeps no in-memory "done today" flag across restarts, on
 * purpose: the panel itself says whether today is claimed, so a restart
 * mid-day simply looks again and finds either a job to do or `already`. A
 * persisted flag would be wrong in exactly the case that matters -- a day
 * having rolled over while the host was off.
 *
 * Skips are outcomes, not silence:
 *   - disabled        -> no request at all
 *   - settled today   -> claimed / already / no_task are not retried
 *   - cooling down    -> inactive is not retried until its cooldown expires
 *   - failed, needs_login -> retried on the next tick
 *
 * `inactive` earns a cooldown rather than a plain settle because the answer is
 * not about this process: measured 2026-11-18, the claim endpoint refused while
 * the panel still offered the task. Re-asking every ten minutes cannot change
 * that and does bury the log, so it waits out {@link CHECKIN_REFUSED_COOLDOWN_MS}.
 *
 * `needs_login` is retried, unlike an earlier version that settled it: a stale
 * session and a refused claim look alike from here, and the user may well have
 * scanned the QR since the last tick. The retry is cheap -- the call fails
 * immediately -- and a permanently missing session is still reported by every
 * attempt to the card.
 */
export function startDoubaoAutoCheckin(deps: {
  enabled: () => boolean
  onResult?: (view: DoubaoCheckinView) => void
  tickMs?: number
  firstTickMs?: number
}): DoubaoAutoCheckinHandle {
  const tickMs = deps.tickMs ?? CHECKIN_TICK_MS
  const firstTickMs = deps.firstTickMs ?? CHECKIN_FIRST_TICK_MS
  let settledDay: string | undefined
  /** A refused claim answers nothing new until this instant. */
  let retryAfter: number | undefined
  let lastView: DoubaoCheckinView | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const sweep = async (): Promise<DoubaoCheckinView | null> => {
    if (stopped) return null
    if (!deps.enabled()) return null
    const day = beijingDayKey()
    if (settledDay === day) return null
    // A refused claim is settled for its cooldown: re-asking inside the hour only
    // burns a request and rewrites the same log line.
    if (retryAfter !== undefined && Date.now() < retryAfter) return null

    const result = await claimDoubaoCheckin().catch(
      () => view('failed', day, { error: 'claim threw' }),
    )
    lastView = result
    deps.onResult?.(result)
    // Retried outcomes are exactly those that might answer differently next time:
    // a transport blip ('failed') and an expired session ('needs_login', where the
    // user may have scanned the QR since). 'inactive' is upstream saying no.
    if (result.outcome === 'failed') return result
    if (result.outcome === 'needs_login') return result
    if (result.outcome === 'inactive') {
      retryAfter = result.retryAfter ?? Date.now() + CHECKIN_REFUSED_COOLDOWN_MS
      return result
    }
    settledDay = day
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
    last: () => lastView,
  }
}