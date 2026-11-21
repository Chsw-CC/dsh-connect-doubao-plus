import { appendFileSync, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
/**
 * Loopback shim for the Doubao route.
 *
 * pi-ai's OpenAI-completions API object wants an OpenAI-shaped HTTP endpoint.
 * Doubao speaks a private three-line streaming dialect at a different origin,
 * with credentials resolved out of a Chromium profile rather than a bearer
 * token. This shim is the boundary: it terminates an OpenAI-shaped request on
 * an ephemeral 127.0.0.1 port and speaks Doubao upstream.
 *
 * SECURITY. Everything in the inbound half is upstream-independent hardening
 * and is kept deliberately identical to `dsh-connect-workbuddy`'s shim:
 *
 *   * binds 127.0.0.1 only, on an ephemeral port;
 *   * Host header must name loopback (drops DNS-rebinding pages);
 *   * a browser-sent Origin must be loopback;
 *   * a per-process shared secret, compared in constant time, which pi-ai
 *     sends as `Authorization: Bearer`. The secret NEVER leaves this process
 *     and is never forwarded upstream — Doubao authenticates on the cookie
 *     jar, which the shim resolves per request;
 *   * chat POSTs must be `application/json`;
 *   * request bodies are size-capped.
 *
 * Nothing that leaves this process carries the shared secret except the
 * loopback hop, and nothing that arrives is trusted without passing all of the
 * above.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）；
 *   入站加固层的做法（loopback 绑定、Host/Origin 校验、常量时间 bearer 比对、
 *   JSON content-type 强制、body 上限）由该项目确立，本文件原样复用其安全策略。
 *
 * @module dsh-connect-doubao-plus/shim
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  ConversationStore,
  continuationDelta,
  isContinuation,
  sessionKeyOf,
} from './doubao-session.ts'
import {
  clearCredentialCache,
  invalidateCredentialCache,
  loadDoubaoCredentials,
  type DoubaoCredentials,
} from './doubao-auth.ts'
import {
  chat,
  stopGeneration,
  DoubaoUpstreamError,
  classifyDoubaoFailure,
  invalidateRenewals,
  isInvalidParamFailure,
  isRetryableFailure,
  type ChatRequestOptions,
  type DoubaoErrorKind,
  type DoubaoImage,
} from './doubao-upstream.ts'
import { fetchQuota, findWindow, millisUntilReset, peekQuota, remainingTotal, type DoubaoQuota } from './doubao-quota.ts'
import {
  DOUBAO_IMAGE_MODEL_ID,
  DOUBAO_MODELS,
  findDoubaoModel,
  isTaskModel,
  SKILL_CARRIER_MODEL_ID,
  type DoubaoModelInfo,
  type DoubaoSkillName,
} from './doubao-catalog.ts'
import { isDiscoveredTaskModel, peekModels } from './doubao-discovery.ts'
import {
  buildToolContract,
  parseToolCalls,
  toolResultAsText,
  type EmulatedToolCall,
  type InboundTool,
} from './doubao-tools.ts'
import { resolveChatUsage, type TokenizableToolCall } from './doubao-tokens.ts'
import { DoubaoStatsTracker, type DoubaoStatsView } from './doubao-stats.ts'

/** Hostnames the inbound half will accept. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Cap on an inbound chat body. Doubao replies are short; anything larger is abuse. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Streaming idle ceiling while one read is outstanding. */
export const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Strip a port and IPv6 brackets from a Host/Origin hostname. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * The Host header must name loopback. A DNS-rebinding page re-resolves an
 * attacker domain to 127.0.0.1 but still sends its own domain in Host, so this
 * drops those before any routing happens.
 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin must be loopback. Non-browser clients send no Origin
 * at all and pass.
 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each Doubao failure class surfaces as. */
const KIND_STATUS: Readonly<Record<DoubaoErrorKind, number>> = {
  rate_limited: 429,
  quota_exhausted: 429,
  session_dead: 401,
  network: 502,
  upstream: 502,
  // 409, not 502: nothing is broken on the wire, and 502 would invite the host's
  // retry classifier to burn the budget on a state only a toggle can change.
  task_runtime_unavailable: 409,
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** OpenAI-shaped error envelope, which is what pi-ai parses. */
function writeOpenAIError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { message, type: code, code } })
}

export interface DoubaoShim {
  /**
   * Origin pi-ai should point its OpenAI client at.
   *
   * Awaits the listening socket. `server.listen()` is asynchronous, so a
   * caller that reads `server.address()` immediately gets `null` — which is
   * exactly what happens when the adapter builds its first model snapshot
   * during registration, moments after the shim is created. Callers must
   * await this rather than assume the port is already bound.
   */
  baseUrl(): Promise<string>
  /** Per-process shared secret, handed to pi-ai as the OpenAI apiKey. */
  token(): string
  /**
   * Origin, or `undefined` while the socket is still binding.
   *
   * pi-ai's `getModels` is synchronous, so the adapter cannot await the port.
   * This is the sync view it reads; `baseUrl()` is the awaitable one used by
   * callers that can wait (the doctor, and the adapter's own warm-up).
   */
  baseUrlSync(): string | undefined
  /** Current session & token usage snapshot recorded by this shim. */
  stats(): DoubaoStatsView
  /** Clear accumulated runtime session & token statistics. */
  resetStats(): void
  /** Release the port. */
  close(): Promise<void>
}

/** Minimal OpenAI chat request shape the shim accepts. */
interface InboundChatRequest {
  model?: string
  messages?: Array<{
    role?: string
    content?: unknown
    /** Present on `role: "tool"` messages. */
    tool_call_id?: string
    name?: string
    /** Historical assistant tool calls echoed back by OpenAI clients. */
    tool_calls?: TokenizableToolCall[]
  }>
  stream?: boolean
  stream_options?: {
    include_usage?: boolean
  }
  /**
   * Thinking level as spelled by the adapter's `thinkingLevelMap`
   * (minimal | low | medium | high, or null for off).
   */
  reasoning_effort?: string | null
  /**
   * Declared tools. Doubao ignores these on the wire; they are only used when
   * tool emulation is switched on, where they become the prompt contract.
   */
  tools?: InboundTool[]
}

/**
 * Translate the adapter's thinking-level spelling into a Doubao level id.
 *
 * The adapter already speaks catalog ids, and those are the same five the client
 * menu offers (低 / 中 / 高 / 极高 / 最高), so this is mostly a passthrough — but
 * pi-ai's own spellings can still arrive from a hand-written request, and those
 * collapse onto the nearest Doubao rung: `minimal` means 低, `medium` means 中.
 * An unrecognised or absent value leaves the default in place.
 */
function toDoubaoLevel(
  spelling: string | null | undefined,
): 'low' | 'mid' | 'high' | 'xhigh' | 'max' | undefined {
  switch (spelling) {
    case 'minimal':
    case 'low':    return 'low'
    case 'medium': return 'mid'
    case 'high':   return 'high'
    // Declared by the client menu for DeepSeek / Kimi / 2.1 Max. They used to be
    // clamped to 高 here, which made the top two rungs of those models unreachable.
    case 'xhigh':  return 'xhigh'
    case 'max':    return 'max'
    default:       return undefined
  }
}

/**
 * The catalog as this process last resolved it — WITHOUT a refresh.
 *
 * `liveModels()` is correct for the picker and the settings card, because those
 * can afford a re-read. It is wrong HERE: this runs per request, and when the
 * 10-minute memo lapses the re-read does synchronous disk work (a JSON.parse of
 * the client's Preferences plus a full read of every LevelDB segment) on the
 * request path, blocking the event loop for every stream the host is serving.
 *
 * A stale snapshot is harmless for what this file asks: whether a model id is
 * filed under 「工作任务」 and whether this release has a display name for it.
 * Both change only when Doubao ships a model, and the next discovery refresh —
 * which the picker, the card and the periodic refresh all trigger on their own
 * threads of control — picks that up.
 */
function catalogSnapshot(): readonly DoubaoModelInfo[] {
  return peekModels() ?? DOUBAO_MODELS
}

/**
 * Name the model a request ASKED for, in words a user can read.
 *
 * Doubao's `model_item_key` values are opaque (`0`, `3`, `5`, `seed-lite-7b`),
 * so the wire key means nothing outside the client. Returning the name — and
 * naming the field `requested_model` rather than `model` — keeps the statement
 * inside what we actually know: this is what we sent, not what served the
 * reply. An id the catalog does not know is echoed verbatim with `unknown`, so
 * a typo cannot be mistaken for a valid model.
 */
function describeRequestedModel(key: string | undefined): {
  name: string
  item_key: string
  unknown?: boolean
} {
  if (key === undefined) {
    const fallback = findDoubaoModel(undefined)
    return { name: fallback.name, item_key: fallback.id }
  }
  // `known` means "this release has a display name for it", which is a narrower
  // question than "the key is real": a model the client menu discovered after this
  // build shipped is forwarded correctly but can only be echoed by its key.
  const discovered = catalogSnapshot().find((model) => model.id === key)
  if (discovered !== undefined) return { name: discovered.name, item_key: key }
  const known = DOUBAO_MODELS.some((model) => model.id === key)
  return known
    ? { name: findDoubaoModel(key).name, item_key: key }
    : { name: key, item_key: key, unknown: true }
}

/**
 * Resolve the per-request upstream knobs from an inbound request.
 *
 * Without this the shim would silently discard the model the caller picked:
 * the inbound `model` is a catalog id that IS Doubao's `model_item_key`, and
 * `reasoning_effort` is the adapter's level spelling.
 */
export function requestOptions(
  parsed: {
    model?: string | undefined
    reasoning_effort?: string | null | undefined
  },
): {
  modelKey?: string
  reasoningLevel?: 'low' | 'mid' | 'high' | 'xhigh' | 'max'
  skill?: DoubaoSkillName
  deepThink?: boolean
  taskMode?: boolean
} {
  const level = toDoubaoLevel(parsed.reasoning_effort)
  /**
   * The 深度思考 switch, ON by default.
   *
   * The level the picker sends only reaches the wire as `reasoning_effort`
   * (3/4/5), and the server ignores it for thinking unless this switch is also
   * open: measured 2026-11-07, the same model answered with `thinking: false`
   * while effort was already 5, because every turn went out as an ordinary one
   * with `need_deep_think: 0`. Without this the picker's 低/中/高 is a control
   * that changes nothing — which is exactly what it looked like.
   *
   * `DSH_DOUBAO_DEEP_THINK=0` turns it back off, for the one case worth
   * debugging that way: a thinking turn whose first token arrives much later.
   *
   * 「工作任务」 models are deliberately left UNSET rather than sent `true`:
   * their captured shape is `need_deep_think: 10001`, and `buildChatBody` only
   * emits it while `deepThink` is `undefined`. Passing a boolean here would
   * silently downgrade every task turn to the chat shape.
   */
  // 「豆包 生图」 is a DSH-side alias, not a Doubao model_item_key: Doubao has no
  // model by that name. Selecting it runs an ordinary chat turn under the
  // imageGen skill, which is what makes the reply carry a creation block. The
  // carrier model is the app's own default, with deepThink forced off so
  // Seedream draws immediately instead of reasoning or answering in text.
  if (isImageModel(parsed.model)) {
    return {
      modelKey: SKILL_CARRIER_MODEL_ID,
      skill: 'imageGen',
      deepThink: false,
    }
  }
  // A model the client menu discovered but this release's static catalog does not
  // name is still a real key, and its mode comes with it: the third-party models
  // are filed under 工作任务 (mode_id "3") with no 「工作任务」 prefix to spot them.
  const discovered = catalogSnapshot().find((model) => model.id === parsed.model)
  const taskModel = isTaskModel(parsed.model)
    || discovered?.taskMode === true
    // The snapshot falls back to the static list when discovery has not run yet
    // (or was just invalidated); the last menu dump still knows this model is
    // task-mode, and losing that flag would send it down the ordinary-chat path.
    || (parsed.model !== undefined && isDiscoveredTaskModel(parsed.model))
  const think = taskModel
    ? {}
    : {
        deepThink: parsed.reasoning_effort === 'off'
          ? false
          : process.env.DSH_DOUBAO_DEEP_THINK !== '0',
      }
  return {
    ...think,
    ...parsed.model === undefined ? {} : { modelKey: parsed.model },
    ...level === undefined ? {} : { reasoningLevel: level },
    // Explicit, so a discovered task model keeps 工作任务 shape (conversation_mode 2,
    // mode_id 3, 256k token limit) instead of silently becoming an ordinary chat.
    ...taskModel ? { taskMode: true } : {},
  }
}

/**
 * Render generated images as Markdown so they survive a text-only transport.
 *
 * The OpenAI surface pi-ai speaks has no image part on the assistant side, so
 * the URL in text is what reaches the user — and it is also what makes the
 * Harness able to download the file afterwards.
 */
export function imageMarkdown(images: readonly DoubaoImage[]): string {
  if (images.length === 0) return ''
  return images
    .map((image, i) => `![豆包生图 ${i + 1}](${markdownSafeUrl(image.url)})`)
    .join('\n\n')
}

/**
 * Where generated pictures are kept.
 *
 * `DSH_DOUBAO_IMAGES_DIR` overrides it — for a small system drive, a roaming
 * profile, or a test fixture. The default sits next to the credential cache so
 * the whole plugin owns one directory under `~/.dsh`.
 */
export function imageCacheDir(): string {
  const override = process.env.DSH_DOUBAO_IMAGES_DIR?.trim()
  return override !== undefined && override !== '' ? override : join(homedir(), '.dsh', 'doubao-images')
}

/** Per-download deadline. A CDN that goes quiet used to hang the turn forever. */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000

/**
 * Largest single picture worth keeping.
 *
 * A 2048×2048 JPEG is well under 8 MB; 24 MB is enough head-room for a
 * lossless take while still bounding what one upstream response can pin on
 * disk. Past the cap the picture is dropped and the URL stays in its place.
 */
const IMAGE_MAX_BYTES = 24 * 1024 * 1024

/**
 * How many pictures one turn will save locally.
 *
 * The rest keep their (already Markdown-safe) URLs: a runaway creation block
 * with fifty images is a bug upstream, not a reason to start fifty downloads.
 */
const IMAGE_MAX_EMBEDDED = 8

/** Pictures older than this are pruned at startup. */
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/**
 * And an abandoned download is given up on much sooner.
 *
 * A `.part` file means the process died (or the socket did) between `create`
 * and `rename`; nobody will ever reference it, so keeping it for the full
 * picture lifetime only wastes the disk it occupies.
 */
const IMAGE_PART_TTL_MS = 24 * 60 * 60 * 1000
/** And the directory as a whole is kept under this. */
const IMAGE_CACHE_MAX_BYTES = 512 * 1024 * 1024

/**
 * IMAGEGEN_LOCAL_FILE: download the picture and reference it locally.
 *
 * The Harness renders local files reliably; a signed CDN URL in Markdown shows
 * up as 「图片无法预览」 (the `~tplv-…` segment breaks link parsing and the
 * origin may be blocked). Saving the bytes next to the session sidesteps both.
 *
 * Returns Markdown with the local path, or the remote URL when the download
 * fails — a broken preview is better than a missing picture.
 *
 * PERF and SAFETY, in the order they were fixed:
 *
 * 1. Downloads run CONCURRENTLY. They were a `for` loop with `await`, so a
 *    four-image turn paid the sum of four round trips while the stream's
 *    `finish_reason` chunk waited behind them (measured 608 ms → 165 ms).
 * 2. Bytes are STREAMED to disk through `pipeline`, not buffered. `arrayBuffer()`
 *    held the whole picture in memory, and `writeFileSync` then blocked the
 *    event loop for the duration of the write — every other session's stream
 *    stalled with it. Peak memory per image is now one stream chunk.
 * 3. Each download has its own deadline and a hard size cap: a slow or
 *    oversized response cannot hold the turn or the disk.
 * 4. The file name carries a random suffix. Same-second, same-index turns
 *    (two chats drawing at once) used to overwrite each other's pictures.
 * 5. A `.part` file is used and renamed on success, so a failed download never
 *    leaves a truncated image behind under a name that looks finished.
 */
export async function imageMarkdownLocal(
  images: readonly DoubaoImage[],
  options: { maxBytes?: number } = {},
): Promise<string> {
  if (images.length === 0) return ''
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES
  const dir = imageCacheDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // An unwritable directory is not fatal: every image falls back to its URL.
  }

  const parts = await Promise.all(images.map(async (image, i): Promise<string> => {
    const label = `豆包生图 ${i + 1}`
    const fallback = `![${label}](${markdownSafeUrl(image.url)})`
    if (i >= IMAGE_MAX_EMBEDDED) return fallback
    // The suffix keeps concurrent turns apart; the index keeps the pictures in
    // the order Doubao produced them.
    const file = join(dir, `doubao-${stamp}-${randomBytes(3).toString('hex')}-${i + 1}.png`)
    const temp = `${file}.part`
    try {
      const res = await fetch(image.url, {
        signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
      })
      if (!res.ok || res.body === null) return fallback
      let received = 0
      let tooLarge = false
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          if (received > maxBytes) {
            tooLarge = true
            callback(new Error('image exceeds the local cache size cap'))
            return
          }
          callback(null, chunk)
        },
      })
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      await pipeline(source, meter, createWriteStream(temp))
      if (tooLarge) {
        await rm(temp, { force: true }).catch(() => {})
        return fallback
      }
      await rename(temp, file)
      return `![${label}](${file.replace(/\\/g, '/')})`
    } catch {
      // Timeout, aborted body, size cap, unwritable disk: leave the URL.
      await rm(temp, { force: true }).catch(() => {})
      return fallback
    }
  }))
  return parts.join('\n\n')
}

/**
 * Trim the picture cache: age first, then total size.
 *
 * Both bounds exist because the directory is otherwise unbounded — a heavy
 * image user accumulates hundreds of megabytes that nothing ever revisits,
 * and it lives in the user's home directory rather than under any store
 * with an eviction policy. Pruning runs at plugin startup (never on the
 * request path) and only touches files this plugin writes, including
 * abandoned `.part` leftovers.
 *
 * Returns `{ removed, keptBytes }` for the diagnostics line; failures are
 * swallowed because a cache that cannot be cleaned must not stop the plugin.
 */
export async function pruneImageCache(options: {
  dir?: string
  now?: number
  ttlMs?: number
  maxBytes?: number
} = {}): Promise<{ removed: number; keptBytes: number }> {
  const dir = options.dir ?? imageCacheDir()
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? IMAGE_CACHE_TTL_MS
  const maxBytes = options.maxBytes ?? IMAGE_CACHE_MAX_BYTES
  let removed = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const kept: Array<{ path: string; size: number; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !/^doubao-.*\.(png|part)$/.test(entry.name)) continue
      const path = join(dir, entry.name)
      try {
        const info = await stat(path)
        const ageLimit = entry.name.endsWith('.part') ? Math.min(ttlMs, IMAGE_PART_TTL_MS) : ttlMs
        if (now - info.mtimeMs > ageLimit) {
          await rm(path, { force: true })
          removed += 1
          continue
        }
        kept.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // Vanished or unreadable between readdir and stat: nothing to do.
      }
    }
    let keptBytes = kept.reduce((total, file) => total + file.size, 0)
    if (keptBytes > maxBytes) {
      // Oldest first: the newest pictures are the ones a session still references.
      kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const file of kept) {
        if (keptBytes <= maxBytes) break
        try {
          await rm(file.path, { force: true })
          keptBytes -= file.size
          removed += 1
        } catch {
          /* best effort */
        }
      }
    }
    return { removed, keptBytes }
  } catch {
    // No directory yet, or unreadable: nothing cached, nothing to prune.
    return { removed, keptBytes: 0 }
  }
}

/**
 * IMAGEGEN_URL_SAFE: make a CDN URL survive Markdown link parsing.
 *
 * Doubao's signed URLs carry `~tplv-…` and `x-signature=…%3D`. A bare `~` is the
 * strikethrough marker, so the link breaks and the Harness renders
 * 「图片无法预览：*」 instead of the picture. Percent-encoding the path segment
 * keeps the bytes identical while removing the ambiguous characters.
 */
function markdownSafeUrl(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return ''
  // Split query off so its separators are not re-encoded.
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const query = q === -1 ? '' : raw.slice(q)
  const safePath = path.replace(/~/g, '%7E').replace(/\(/g, '%28').replace(/\)/g, '%29')
  const safeQuery = query.replace(/\(/g, '%28').replace(/\)/g, '%29')
  return safePath + safeQuery
}

/**
 * Flatten pi-ai's content shapes (string | block array) into plain text.
 *
 * Doubao's endpoint takes one `text_block`, so multimodal blocks are not
 * forwarded: this provider advertises text-only input and the adapter never
 * offers anything else.
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (block && typeof block === 'object') {
      const record = block as { type?: string; text?: unknown; content?: unknown }
      if (typeof record.text === 'string') parts.push(record.text)
      else if (typeof record.content === 'string') parts.push(record.content)
    }
  }
  return parts.join('\n')
}

/**
 * Assemble the final prompt from the inbound transcript.
 *
 * Doubao's endpoint carries one user message; a multi-turn transcript is
 * flattened newest-last with role prefixes so the model still sees the
 * history. The system prompt is folded in as context rather than dropped.
 *
 * A `role: "tool"` message becomes a `[tool result] …` line, which is the exact
 * shape the tool contract promises — the model is asked to recognise that prefix,
 * so the two sides must not drift apart.
 */

/**
 * Whether this turn targets the image alias.
 *
 * DSH may spell the model id with a provider prefix (`doubao/image-gen`) or in
 * another case; a missed match silently falls back to the full agent prompt,
 * which is how framework text ended up drawn into the picture.
 */
function isImageModel(model: string | undefined): boolean {
  if (typeof model !== 'string' || model === '') return false
  const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return tail.trim().toLowerCase() === DOUBAO_IMAGE_MODEL_ID
}

/**
 * IMAGEGEN_PROMPT: pick the sentence the user actually typed.
 *
 * The transcript DSH hands us is not just that sentence: it carries the
 * developer prompt, a runtime snapshot, the skill catalog, the MCP listing and
 * memory pages, each as its own `user` message. Taking the last user message
 * therefore picked up a `<system-reminder>` block, and Doubao drew that text
 * into the picture — the reported "turn 1 step 1 / tup / tun" artefacts.
 *
 * A picture description is short and plain, so a message qualifies only when it
 * is bounded in length and carries no known marker or XML-ish wrapper.
 */
const FRAMEWORK_MARKERS = [
  'Current runtime context',
  'Current working directory:',
  'Time sampled while preparing',
  'Elapsed since the preceding',
  'Available skills:',
  '[Plugin context from',
  '[the previous turn was interrupted',
  '<system-reminder>',
  '<available_skills>',
  '<mcp_catalog>',
  '<hindsight_pages>',
  '<hindsight_page_refresh>',
  '<hindsight_knowledge',
  'A skill is a reusable set of task-specific instructions',
  'The following MCP servers are available',
  'You are an AI agent powered by',
]

/** Anything longer than this is machine context, not a picture request. */
const MAX_IMAGE_PROMPT_CHARS = 2000

function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<hindsight_page_refresh>[\s\S]*?<\/hindsight_page_refresh>/g, '')
    .trim()
}

function looksLikeFramework(text: string): boolean {
  const head = text.slice(0, 400)
  if (head.startsWith('<')) return true
  if (/^[<\[]/.test(head) && head.includes('>')) return true
  return FRAMEWORK_MARKERS.some((marker) => head.includes(marker))
}

export function buildImagePrompt(
  all: ReadonlyArray<{ role?: string; content?: unknown; name?: string }>,
  outgoing: ReadonlyArray<{ role?: string; content?: unknown; name?: string }>,
): string {
  const source = all.length > 0 ? all : outgoing
  let fallback = ''
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const message = source[i]
    if (message === undefined) continue
    if ((message.role ?? 'user') !== 'user') continue
    const text = stripInjectedBlocks(flattenContent(message.content))
    if (text === '' || looksLikeFramework(text)) continue
    if (text.length <= MAX_IMAGE_PROMPT_CHARS) return text
    if (fallback === '') fallback = text.slice(0, MAX_IMAGE_PROMPT_CHARS)
  }
  return fallback
}

function buildPrompt(
  messages: Array<{
    role?: string
    content?: unknown
    name?: string
    tool_calls?: TokenizableToolCall[]
  }> | undefined,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const turns: string[] = []
  for (const message of messages) {
    const text = flattenContent(message.content)
    const role = message.role ?? 'user'
    if (role === 'tool') {
      if (text) turns.push(toolResultAsText(message.name, text))
      continue
    }
    // Replay an assistant turn that carried tool calls back into the prompt as
    // the same ```doubao-tool fence the model is asked to emit, so a continued
    // conversation keeps the call/result pairing the emulation depends on. An
    // assistant message can have empty content but non-empty tool_calls, so this
    // branch must run BEFORE the empty-text skip below.
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const fencedCalls = message.tool_calls
        .map((tc) => {
          const fnName = tc.function?.name ?? ''
          const rawArgs = tc.function?.arguments
          // arguments is typed `unknown` (OpenAI wire = JSON string, but a caller
          // may hand us an already-parsed object). Only parse when it is a string.
          let parsedArgs: unknown = rawArgs ?? {}
          if (typeof rawArgs === 'string') {
            try {
              parsedArgs = JSON.parse(rawArgs)
            } catch {
              /* keep the raw string when it is not valid JSON */
            }
          }
          return `\`\`\`doubao-tool\n${JSON.stringify({ name: fnName, arguments: parsedArgs })}\n\`\`\``
        })
        .join('\n\n')
      const trimmed = text.trim()
      const combined = trimmed ? `${trimmed}\n\n${fencedCalls}` : fencedCalls
      turns.push(`[assistant] ${combined}`)
      continue
    }
    if (!text) continue
    turns.push(role === 'user' ? text : `[${role}] ${text}`)
  }
  return turns.join('\n\n')
}

export interface DoubaoShimOptions {
  /** Resolve credentials per request, so a re-login is picked up without a restart. */
  resolveCredentials?: () => DoubaoCredentials
  /**
   * Whether to simulate tool calling in the prompt.
   *
   * Read per request (not once at construction) because the user can flip the
   * setting without restarting the host.
   */
  toolEmulation?: () => boolean
  /** Optional shared stats tracker; defaults to a per-shim instance. */
  stats?: DoubaoStatsTracker
}

/**
 * The `error.type` / `error.code` string for one class of failure.
 *
 * pi-ai's retry policy reads these names, so they are a contract, not cosmetics:
 * a non-retryable failure that says TIMEOUT invites a retry storm that cannot
 * succeed.
 */
function errorCodeFor(kind: DoubaoErrorKind, retryable: boolean): string {
  if (kind === 'rate_limited' || kind === 'quota_exhausted') return 'RATE_LIMIT'
  if (kind === 'network') return retryable ? 'TIMEOUT' : 'SERVER'
  return 'SERVER'
}

/**
 * Forget a session the server has rejected.
 *
 * Both the in-memory copy and the sealed one on disk: the sealed session has no
 * TTL (its real deadline is the server's, not a local clock), so leaving it in
 * place would hand the rejected cookie back on every later request — with the
 * card still showing a signed-in account, which makes the user's fix (「重新登录」)
 * look like it did nothing.
 */
function revokeSession(): void {
  invalidateCredentialCache()
  clearCredentialCache()
  // The rotated cookies (`x-ms-token`, `bd_sso_hi3jfd`, …) that
  // `absorbSetCookies` remembers are the OTHER half of the dead credential.
  // Leaving them in place meant the next request — including the first one
  // after a fresh QR scan — overlaid the previous session's values onto the new
  // session's header, which the server reads as a still-dead login. The two
  // caches must be dropped together; see `invalidateRenewals`.
  invalidateRenewals()
}

/**
 * Per-request cancellation and liveness.
 *
 * Two failures share one root cause: nothing ever told the upstream turn to
 * stop. A client that hung up (Stop button, window closed, Harness shutting
 * down) left Doubao generating for minutes — spending quota on an answer nobody
 * would read — and a stream that went silent held the request open with no way
 * out. Both end in `signal` being aborted, which reaches the socket through
 * `fetch`, not just our side of it.
 *
 * `release` is wired to the response's own terminal events so every exit path
 * (finished, failed, client gone) tears the watchdog down without each branch
 * having to remember.
 */
export function createRequestLifecycle(
  res: ServerResponse,
  options: { idleMs?: number } = {},
): { signal: AbortSignal; onActivity: () => void; clientGone: () => boolean; release: () => void; abortUpstream: (reason?: Error) => void } {
  const idleMs = options.idleMs ?? DOUBAO_STREAM_IDLE_TIMEOUT_MS
  const abort = new AbortController()
  let gone = false
  const onClose = (): void => {
    // `close` also fires after a normal end; only a close before the response
    // finished means the caller left.
    if (res.writableEnded) return
    gone = true
    abort.abort()
  }
  res.on('close', onClose)
  let timer: ReturnType<typeof setTimeout> | undefined
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  /** Reset the watchdog: an upstream delta is proof of life. */
  const onActivity = (): void => {
    disarm()
    timer = setTimeout(() => {
      abort.abort(new Error(
        `豆包 ${Math.round(idleMs / 1000)} 秒内没有返回任何数据，已中止本次请求。`,
      ))
    }, idleMs)
    timer.unref?.()
  }
  const release = (): void => {
    disarm()
    res.off('close', onClose)
  }
  res.once('finish', release)
  res.once('close', release)
  onActivity()
  /**
   * Hard-abandon the upstream fetch after a terminal failure.
   *
   * `reader.cancel()` only lets go of the body; aborting the signal closes the
   * socket itself, which is the same reach `stop` has — without it a failed
   * turn leaves Doubao generating into a connection nobody reads.
   */
  const abortUpstream = (reason?: Error): void => {
    abort.abort(reason ?? new Error('豆包上游请求已中止。'))
  }
  return { signal: abort.signal, onActivity, clientGone: () => gone, release, abortUpstream }
}

/**
 * SSE response sink: bounded flow control plus a keep-alive comment.
 *
 * Both halves come from failures that are invisible until they are expensive.
 *
 * 1. `res.write()` returns `false` once the socket's buffer is full, and every
 *    call site here ignored it. A client reading slower than Doubao produces —
 *    a paused window, a debugger, a host doing its own work mid-stream —
 *    therefore made Node buffer the REST of the turn in memory, with no ceiling
 *    and no symptom until the process grew. The queue below is bounded; past
 *    the cap the turn is failed with a message the user can act on instead of
 *    quietly eating the host's heap.
 *
 * 2. A stream that sends nothing for minutes is indistinguishable from a dead
 *    one to every hop in between. A `:`-prefixed line is a legal SSE no-op that
 *    the OpenAI SDK's decoder drops outright (`line.startsWith(':') -> null`),
 *    but it is still bytes on the wire: the client's own idle watchdog is
 *    refreshed, and a proxy that reaps silent connections keeps ours.
 *
 * The heartbeat deliberately does NOT feed this plugin's idle watchdog — that
 * one must still fire when DOUBAO itself goes quiet. It only keeps the CLIENT
 * from timing out first, which used to produce two different error messages for
 * one identical stall.
 */
export interface DoubaoStreamSink {
  /** Queue-or-write one chunk, honouring backpressure, coalescing per tick. */
  write(text: string): void
  /** Emit one SSE comment line; skipped while the socket is backed up. */
  beat(): void
  /**
   * Hand anything still queued to the socket RIGHT NOW.
   *
   * Required before `res.end()`: writes are coalesced into a microtask, and
   * ending the response first would drop the last batch on the floor.
   */
  flush(): void
  dispose(): void
}

/** A client this far behind is not coming back; fail the turn instead of buffering. */
const SSE_MAX_QUEUED_BYTES = 4 * 1024 * 1024

/** Silence after which the client gets a comment line to chew on. */
const SSE_HEARTBEAT_MS = 15_000

export function createStreamSink(
  res: ServerResponse,
  options: { heartbeatMs?: number; maxQueuedBytes?: number; onOverflow?: (error: Error) => void } = {},
): DoubaoStreamSink {
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS
  const maxQueuedBytes = options.maxQueuedBytes ?? SSE_MAX_QUEUED_BYTES

  let blocked = false
  /** Chunks not yet handed to the socket, each with its precomputed size. */
  let queued: Array<{ text: string; bytes: number }> = []
  let queuedBytes = 0
  let flushScheduled = false
  let disposed = false
  let lastWriteAt = Date.now()

  const usable = (): boolean => !disposed && !res.writableEnded && !res.destroyed

  const clearQueue = (): void => {
    queued = []
    queuedBytes = 0
  }

  /**
   * Hand the whole pending batch to the socket as ONE write.
   *
   * WHY. A read from Doubao routinely carries dozens of frames, and each of
   * them used to be its own `res.write()`. Measured on a loopback socket: 5 000
   * SSE chunks cost 36–54 ms written one by one and 2.6–3.3 ms written as a
   * batch — every write pays a syscall plus a chunked-encoding frame, and the
   * client receives the same bytes either way (SSE delimits with `data:` blocks,
   * not with transport chunks).
   *
   * `res.write` returning false does NOT mean the bytes were lost: they are in
   * Node's socket buffer, and the only consequence is that we must stop writing
   * until `drain`.
   */
  const pumpNow = (force = false): void => {
    if (queuedBytes === 0) return
    if (disposed || !usable()) {
      clearQueue()
      return
    }
    // `force` exists for `flush()`: at the end of a turn the response is about
    // to close, so handing the batch to Node (even though the socket is full)
    // is the only way those bytes ever reach the client. `blocked` is advisory.
    if (blocked && !force) return
    const batch = queued
    queued = []
    queuedBytes = 0
    lastWriteAt = Date.now()
    if (!res.write(batch.map((entry) => entry.text).join(''))) blocked = true
  }

  /** Coalesce every write made in this tick into one socket write. */
  const scheduleFlush = (): void => {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      pumpNow()
    })
  }

  const flush = (): void => {
    flushScheduled = false
    pumpNow(true)
  }

  const write = (text: string): void => {
    if (!usable()) return
    const bytes = Buffer.byteLength(text)
    lastWriteAt = Date.now()
    // Fast path: nothing pending, so the first chunk of a burst goes out at
    // once and interactive latency does not wait for the tick to end.
    //
    // The tick is then marked open: everything else that arrives before the
    // microtask runs is collected and sent as ONE write. Without this marker a
    // burst would take the fast path once per chunk (the queue never has
    // anything in it), which is exactly the per-event write this exists to
    // avoid.
    if (!blocked && queuedBytes === 0 && !flushScheduled) {
      if (!res.write(text)) blocked = true
      scheduleFlush()
      return
    }
    if (queuedBytes + bytes > maxQueuedBytes) {
      clearQueue()
      options.onOverflow?.(new Error(
        `客户端读取过慢，已中止本轮：未发送的缓冲超过 ${Math.round(maxQueuedBytes / 1048576)} MB。`,
      ))
      return
    }
    queued.push({ text, bytes })
    queuedBytes += bytes
    if (!blocked) scheduleFlush()
  }

  const onDrain = (): void => {
    blocked = false
    pumpNow()
  }
  res.on('drain', onDrain)

  const timer = setInterval(() => {
    if (!usable() || blocked) return
    if (Date.now() - lastWriteAt < heartbeatMs) return
    // Skip the queue on purpose: a backed-up socket already has bytes to
    // deliver, and a heartbeat is the first thing that may be dropped.
    lastWriteAt = Date.now()
    if (res.write(': keepalive\n\n')) return
    blocked = true
  }, Math.max(500, Math.floor(heartbeatMs / 2)))
  timer.unref?.()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    res.off('drain', onDrain)
    clearQueue()
  }
  res.once('finish', dispose)
  res.once('close', dispose)

  return {
    write,
    beat: () => { if (!blocked) write(': keepalive\n\n') },
    flush,
    dispose,
  }
}

/**
 * How long a COLD quota read may hold up a turn.
 *
 * The quota summary endpoint is a convenience check, not a gate the upstream
 * needs: Doubao rejects an exhausted turn itself. But the read used to be
 * awaited with its full 10-second deadline, so the first turn after a cold
 * cache — a fresh host, or five minutes idle — waited up to ten seconds before
 * the first byte of the prompt even left, for an answer it almost never needs.
 *
 * The read still STARTS: it fills the 5-minute cache for the turns that follow.
 * Only the wait is bounded, and a cached reading (the normal case) resolves
 * immediately, so the truthful "quota exhausted" refusal is preserved.
 */
const QUOTA_GATE_BUDGET_MS = 1_500

async function quotaGate(budgetMs = QUOTA_GATE_BUDGET_MS): Promise<DoubaoQuota | undefined> {
  // `fetchQuota` de-duplicates in flight, never rejects, and returns the cached
  // reading synchronously when it has one — so this race costs nothing on the
  // hot path and only bounds the cold one.
  const read = fetchQuota()
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([read, budget])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createDoubaoShim(options: DoubaoShimOptions = {}): DoubaoShim {
  const resolveCredentials = options.resolveCredentials ?? loadDoubaoCredentials

  /**
   * Doubao conversation ids by transcript opening.
   *
   * The Harness resends the whole transcript every turn, so continuity has to be
   * inferred; see `doubao-session.ts` for the rule and why it is conservative.
   * Kept per shim (i.e. per host process) — a restart simply starts new threads.
   */
  const sessions = new ConversationStore()
  const statsTracker = options.stats ?? new DoubaoStatsTracker()
  /**
   * Circuit valve: consecutive upstream failures per conversation.
   *
   * While a conversation is in cooldown NO request leaves the process — no
   * server-side turn can start, so a retry loop can never re-trigger
   * generation and burn quota. Cleared by the next successful turn.
   */
  const recentFailures = new Map<string, { count: number; until: number }>()
  const CIRCUIT_FAILURES = 3
  const CIRCUIT_COOLDOWN_MS = 60_000
  const bumpFailure = (key: string): void => {
    const prev = recentFailures.get(key)
    const count = (prev?.count ?? 0) + 1
    const until = count >= CIRCUIT_FAILURES ? Date.now() + CIRCUIT_COOLDOWN_MS : (prev?.until ?? 0)
    if (recentFailures.size >= 256 && !recentFailures.has(key)) {
      const oldest = recentFailures.keys().next().value
      if (oldest !== undefined) recentFailures.delete(oldest)
    }
    recentFailures.set(key, { count, until })
  }

  /** Prompt-level tool calling; ON by default so Doubao can drive local tools. */
  const emulationOn = options.toolEmulation ?? (() => true)

  // Per-process shared secret. In memory only; pi-ai sends it as
  // `Authorization: Bearer`, the shim validates it, and it is never
  // forwarded upstream — Doubao authenticates on its own cookie jar.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /** Read a size-capped request body. Rejects over-limit and wrong content types. */
  function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        if (aborted) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          aborted = true
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
      req.on('error', () => { if (!aborted) resolve(undefined) })
    })
  }

  const server: Server = createServer((req, res) => {
    // `handle` catches its own failures, but a rejection escaping it would be an
    // UNHANDLED rejection inside the host process — and Node's default reaction
    // to one is to terminate the whole application. A plugin must not be able to
    // do that: this is the last line, and writing a 500 here (when the socket
    // still exists) is the worst it may do.
    void handle(req, res).catch((error: unknown) => {
      try {
        writeFailure(res, error)
      } catch {
        /* headers already sent or socket destroyed — nothing left to say */
      }
    })
  })

  /**
   * Keep the loopback connection alive across turns.
   *
   * Node's default `keepAliveTimeout` is 5 seconds, and pi-ai's OpenAI client
   * keeps its own idle sockets for longer. The mismatch means a conversation
   * with a natural pause between turns threw away a working connection and paid
   * a fresh TCP handshake (and, on this loopback shim, a fresh server-side
   * accept) on the next request. 65s outlives a normal thinking pause, and
   * `headersTimeout` rides one second above it so a half-sent request cannot
   * hold the socket longer than the keep-alive window it belongs to.
   */
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  // A client that opens a request and then dribbles the body (or sends none)
  // otherwise holds a socket until Node's 300 s default. Nothing in this
  // protocol legitimately needs longer: the body is one JSON object.
  server.requestTimeout = 60_000

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  // Loopback only, ephemeral port.
  server.listen(0, '127.0.0.1')

  const baseUrl = async (): Promise<string> => {
    await ready.catch(() => {})
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('doubao shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

/** Translate one Doubao failure into the OpenAI error envelope pi-ai expects. */
  function writeFailure(res: ServerResponse, error: unknown): void {
    // A socket that already went away must not be written to: the client asked
    // for nothing and the write only produces EPIPE noise.
    if (res.writableEnded || res.destroyed) return
    const kind: DoubaoErrorKind = error instanceof DoubaoUpstreamError
      ? classifyDoubaoFailure(error)
      : 'network'
    const message = (error as Error)?.message ?? 'Doubao upstream failed'
    const status = KIND_STATUS[kind]
    // The retry flag is decided by the failure, not by its class: a transport
    // error before any byte is worth retrying, while an HTTP 400 or a truncated
    // stream is not. Only genuinely transient failures may carry a retryable
    // code, otherwise a slider challenge would burn the whole retry budget
    // before failing, and an internal bug would look like a timeout.
    const retryable = isRetryableFailure(error)
    if (!res.headersSent) res.setHeader('x-should-retry', retryable ? 'true' : 'false')
    writeOpenAIError(res, status, errorCodeFor(kind, retryable), message)
  }

  /** Stream a completion as OpenAI SSE chunks. */
  /**
   * Stream one completion back as OpenAI-shaped SSE chunks.
   *
   * `parsed` is needed for the model and thinking level: the prompt alone says
   * nothing about which of them the caller picked.
   *
   * `emulate` switches the reply handling: instead of forwarding text deltas as
   * they arrive, the whole turn is collected and the tool fence is parsed out.
   * Streaming a fence cannot work — the call is only knowable once its JSON is
   * complete — and an emulated turn is slow enough (~11.5s measured) that
   * losing incrementality costs nothing a user would notice.
   */
  async function streamCompletion(
    res: ServerResponse,
    prompt: string,
    parsed: InboundChatRequest,
    upstreamOptions: ChatRequestOptions,
    remember: (conversationId: string | undefined) => void,
    forget: () => void,
    emulate: boolean,
    lifecycle: {
      /** Aborted when the client went away or the stream went silent. */
      signal: AbortSignal
      /** Called on every upstream delta, to reset the idle watchdog. */
      onActivity: () => void
      /** True when the request's client disconnected before we finished. */
      clientGone: () => boolean
      /** Hard-abandon the upstream fetch after a terminal failure. */
      abortUpstream: (reason?: Error) => void
    },
    accounting: {
      modelId: string
      sessionKey: string | undefined
      isContinuationTurn: boolean
      cachedPrefixMessages: number
      emulatedContractText: string
      /**
       * The session the GATE already resolved.
       *
       * Handed down instead of letting `streamOnce` call
       * `loadDoubaoCredentials()` again: one unseal per request instead of two,
       * and — the real reason — a caller that injected its own resolver
       * (`DoubaoShimOptions.resolveCredentials`) is honoured by the upstream
       * call too, not just by the inbound checks.
       */
      credentials: DoubaoCredentials
    },
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // Nagle waits for a full segment before sending, which is exactly wrong for
    // a stream of 20-byte deltas: every token paid the delayed-ACK round trip.
    res.socket?.setNoDelay(true)
    const sink = createStreamSink(res, {
      // A client that cannot keep up is a client that is gone; abort the turn
      // so Doubao stops generating for nobody.
      onOverflow: (error) => lifecycle.abortUpstream(error),
    })

    const chunkId = `doubao-${randomBytes(8).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    const chatStartedAt = Date.now()
    let firstTokenAt: number | null = null
    const markFirstToken = (): void => {
      if (firstTokenAt === null) firstTokenAt = Date.now()
    }
    /**
     * Whether the client has been sent anything it cannot be asked to un-see.
     *
     * Distinct from `firstTokenAt`, which is a latency measurement and fires on
     * ANY non-empty delta including private reasoning. The 710020202 fallback
     * re-issues the turn as a fresh conversation, which is only safe while the
     * client still has nothing from this one. Reasoning does not count: it is a
     * separate `reasoning_content` field, and under tool emulation no text is
     * forwarded at all until the turn completes — which is exactly the setup
     * where a stale thread used to fail the turn outright instead of retrying.
     */
    let visibleContentSent = false

    const sendRaw = (payload: unknown): void => {
      sink.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const sendChunk = (payload: { choices: unknown[]; usage?: unknown }): void => {
      sendRaw({
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model: accounting.modelId,
        ...payload,
      })
    }

    let roleSent = false
    // Turn identity published by SSE_ACK via callbacks.onTurnIds. The local
    // abort only closes our socket — without break_stream_msg Doubao keeps
    // thinking and burning credits for a reply nobody will read.
    const turnIds: { conversationId?: string; questionId?: string } = {}
    let stoppedQuestionId: string | undefined
    const stopActiveTurn = (reason: string): void => {
      const { conversationId, questionId } = turnIds
      // Without both ids there is nothing the stop request can address.
      if (conversationId === undefined || questionId === undefined) return
      // At most one stop per turn (a fallback re-issue carries its own question id).
      if (stoppedQuestionId === questionId) return
      stoppedQuestionId = questionId
      let credentials: DoubaoCredentials
      try {
        credentials = resolveCredentials()
      } catch {
        return
      }
      if (!credentials.ok) return
      // Fire-and-forget: a failed stop must never disturb the response path.
      void stopGeneration(credentials, { conversationId, questionId }).catch((error: unknown) => {
        if (process.env.DSH_DOUBAO_DEBUG_PLAN === '1') {
          process.stderr.write(`[plan] stop-generation(${reason}) failed: ${String(error)}\n`)
        }
      })
    }
    // Fires only on abnormal end (client hang-up, idle watchdog, upstream
    // failure): normal completion never aborts this signal.
    lifecycle.signal.addEventListener('abort', () => stopActiveTurn('abandoned'), { once: true })

    const callbacks = {
      // Private reasoning is forwarded as `reasoning_content`, the field
      // OpenAI-compatible clients read for it. It is NOT mixed into
      // `content`: a client that does not understand it simply ignores it,
      // which is the right degradation.
      onThinking: (delta: string) => {
        lifecycle.onActivity()
        if (delta !== '') markFirstToken()
        // Deliberately does NOT set `visibleContentSent`: reasoning may be re-sent
        // with the fallback turn without the client seeing it twice.
        if (!roleSent) {
          sendChunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
          roleSent = true
        }
        sendChunk({ choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] })
      },
      onText: (delta: string) => {
        lifecycle.onActivity()
        // In emulated mode the fence is still forming, so nothing can be
        // forwarded live; the whole turn is parsed after it completes.
        if (emulate) return
        if (delta !== '') {
          markFirstToken()
          visibleContentSent = true
        }
        if (!roleSent) {
          sendChunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
          roleSent = true
        }
        sendChunk({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
      },
      onTurnIds: (ids: { conversationId?: string | undefined; questionId?: string | undefined }) => {
        if (ids.conversationId !== undefined) turnIds.conversationId = ids.conversationId
        if (ids.questionId !== undefined) turnIds.questionId = ids.questionId
      },
    }
    let result
    try {
      try {
        result = await chat(prompt, {
          ...upstreamOptions,
          signal: lifecycle.signal,
          callbacks,
          credentials: accounting.credentials,
        })
      } catch (error) {
        if (!accounting.isContinuationTurn || !isInvalidParamFailure(error) || visibleContentSent) throw error
        // The remembered thread was rejected as an invalid parameter (710020202):
        // nothing was stored server-side, so the same turn is re-issued as a
        // fresh conversation instead of failing — a stale id must cost one
        // re-upload, not a lost turn. The accounting flips with it so stats
        // credit this turn to the fresh thread.
        forget()
        // The rejected thread may still be generating server-side (the exact
        // symptom: the web session keeps thinking and burning credits after
        // 710020202) — stop it before re-issuing, while its ids are still here.
        stopActiveTurn('fallback-reissue')
        accounting.isContinuationTurn = false
        accounting.cachedPrefixMessages = 0
        if (process.env.DSH_DOUBAO_DEBUG_PLAN === '1') {
          process.stderr.write('[plan] continuation rejected (710020202); re-issuing as fresh conversation\\n')
        }
        result = await chat(buildPrompt(parsed.messages ?? []) + accounting.emulatedContractText, {
          ...requestOptions(parsed),
          signal: lifecycle.signal,
          callbacks,
          credentials: accounting.credentials,
        })
      }
      // Only a completed turn teaches us the thread id; a failed one leaves the
      // previous mapping alone so the next attempt can still continue it.
      remember(result.conversationId)
      if (!roleSent) sendChunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })

      let finishReason = 'stop'
      let visibleAnswerText = result.text
      let calls: EmulatedToolCall[] = []
      if (emulate) {
        const parsedCalls = parseToolCalls(result.text, parsed.tools ?? [])
        // A 「工作任务」 turn does not answer with a fence: the server dispatches
        // workspace commands and the tool_local responder hands back the calls it
        // bridged. Those are already DSH calls, so they join the fenced ones
        // instead of being dropped on the floor.
        calls = [...parsedCalls.calls, ...(result.toolCalls ?? [])]
        visibleAnswerText = parsedCalls.text
        const visible = parsedCalls.text.trim() === '' ? ' ' : parsedCalls.text
        if (parsedCalls.text.trim() !== '' || calls.length > 0) markFirstToken()
        sendChunk({ choices: [{ index: 0, delta: { content: visible }, finish_reason: null }] })
        calls.forEach((call: EmulatedToolCall, index: number) => {
          sendChunk({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                }],
              },
              finish_reason: null,
            }],
          })
        })
        if (calls.length > 0) finishReason = 'tool_calls'
      }
      // Generated images have no place on the OpenAI assistant side, so they are
      // appended to the text as Markdown — which is both what the user sees and
      // what lets the Harness fetch the file afterwards.
      const markdown = await imageMarkdownLocal(result.images)
      if (markdown !== '') {
        markFirstToken()
        sendChunk({ choices: [{ index: 0, delta: { content: `\n\n${markdown}` }, finish_reason: null }] })
      }
      sendChunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })

      const completedAt = Date.now()
      const answerForUsage = [visibleAnswerText, markdown].filter((part) => part !== '').join('\n\n')
      const usage = resolveChatUsage({
        messages: parsed.messages ?? [],
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
        ...(accounting.emulatedContractText !== '' ? { emulatedContractText: accounting.emulatedContractText } : {}),
        cachedPrefixMessages: accounting.cachedPrefixMessages,
        answerText: answerForUsage,
        ...(result.reasoningText !== undefined ? { reasoningText: result.reasoningText } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      })
      const ttftMs = firstTokenAt === null ? null : Math.max(0, firstTokenAt - chatStartedAt)
      const decodeMs = firstTokenAt === null ? 0 : Math.max(0, completedAt - firstTokenAt)
      const durationMs = Math.max(0, completedAt - chatStartedAt)
      statsTracker.recordSuccess({
        model: accounting.modelId,
        ...(accounting.sessionKey !== undefined ? { sessionKey: accounting.sessionKey } : {}),
        stream: true,
        continuation: accounting.isContinuationTurn,
        usage,
        ttftMs,
        durationMs,
        decodeMs,
        ...(result.telemetry?.contextWindowUsage !== undefined
          ? { upstreamContextWindow: result.telemetry.contextWindowUsage }
          : {}),
        ...(result.telemetry?.firstPacketCostMs !== undefined
          ? { upstreamFirstPacketMs: result.telemetry.firstPacketCostMs }
          : {}),
        ...(result.telemetry?.ackCostMs !== undefined
          ? { upstreamAckMs: result.telemetry.ackCostMs }
          : {}),
        now: completedAt,
      })

      if (parsed.stream_options?.include_usage !== false) {
        sendChunk({ choices: [], usage: usage.openai })
      }
      if (!res.writableEnded) {
        sink.write('data: [DONE]\n\n')
        // Writes are coalesced per tick; ending first would discard the batch.
        sink.flush()
        res.end()
      }
      void result
    } catch (error) {
      statsTracker.recordFailure({
        model: accounting.modelId,
        durationMs: Math.max(0, Date.now() - chatStartedAt),
      })
      // Terminal for this attempt: tear the upstream socket down so Doubao is
      // not left generating into a stream nobody will read (quota keeps burning
      // until the server-side turn ends on its own).
      lifecycle.abortUpstream(error instanceof Error ? error : undefined)
      if (error instanceof DoubaoUpstreamError && accounting.sessionKey !== undefined) bumpFailure(accounting.sessionKey)
      const kind: DoubaoErrorKind = error instanceof DoubaoUpstreamError
        ? classifyDoubaoFailure(error)
        : 'network'
      // A thread the server no longer knows must not be retried forever: drop it
      // so the NEXT turn opens a fresh conversation instead of failing the same
      // way for the next 30 minutes.
      if (kind === 'session_dead') {
        forget()
        revokeSession()
      } else if (accounting.isContinuationTurn && isInvalidParamFailure(error)) {
        // 710020202 on a continuation means the remembered conversation id was
        // rejected as an invalid parameter (the thread expired upstream).
        // Without this drop, every later turn resends the same rejected id and
        // fails identically until the store's TTL lapses.
        forget()
      }
      // The client hung up (Stop button, window closed, Harness shutting down).
      // Nothing to report and nobody listening — writing here only produces
      // EPIPE noise, and the upstream call has already been aborted.
      if (lifecycle.clientGone()) return
      // The response has already begun, so the failure can only be reported
      // inside the stream. An error chunk is what pi-ai surfaces to the user.
      sendRaw({
        error: {
          message: (error as Error)?.message ?? 'Doubao upstream failed',
          type: errorCodeFor(kind, isRetryableFailure(error)),
        },
      })
      if (!res.writableEnded && !res.destroyed) {
        sink.write('data: [DONE]\n\n')
        // Same reason as the success path: the error chunk is still queued.
        sink.flush()
        res.end()
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }

      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }

      // Read-only quota view for the plugin UI. Never returns credentials.
      if (req.method === 'GET' && url.startsWith('/quota')) {
        const quota = await fetchQuota()
        const monthly = findWindow(quota, 'monthly')
        writeJson(res, 200, {
          ok: true,
          plan: quota.plan ?? null,
          exhausted: quota.exhausted,
          available: remainingTotal(quota),
          windows: {
            monthly: monthly
              ? {
                  usedPercent: monthly.usedPercent,
                  remainingPercent: monthly.remainingPercent,
                  resetsAt: monthly.resetsAt,
                  resetsInMs: millisUntilReset(monthly),
                }
              : null,
          },
          error: quota.error ?? null,
        })
        return
      }

      const isChat = url.startsWith('/v1/chat/completions') || url === '/v1/chat/completions'
      if (!isChat || req.method !== 'POST') {
        writeOpenAIError(res, 404, 'not_found', 'unsupported route')
        return
      }
      if (!isJsonContentType(req)) {
        writeOpenAIError(res, 415, 'unsupported_media_type', 'chat requests must be application/json')
        return
      }

      const credentials = resolveCredentials()
      if (!credentials.ok) {
        writeOpenAIError(res, 401, 'session_dead', credentials.reason ?? 'Doubao is not signed in')
        return
      }

      const raw = await readBody(req)
      if (raw === undefined) {
        writeOpenAIError(res, 413, 'payload_too_large', 'request body exceeds the size limit')
        return
      }

      let parsed: InboundChatRequest
      try {
        parsed = JSON.parse(raw.toString('utf8')) as InboundChatRequest
      } catch {
        writeOpenAIError(res, 400, 'invalid_request', 'request body is not valid JSON')
        return
      }

      const imageModel = isImageModel(parsed.model)
      const selectedOptions = requestOptions(parsed)

      // Refuse before spending quota when the account has no headroom.
      //
      // The memoised reading is consulted first: five minutes out of every six
      // nothing has gone to the network yet does not have to, and the hot path
      // skips the promise and the watchdog a gate would allocate. Only a genuinely
      // cold cache pays `quotaGate`, which bounds the wait. See both.
      const quota = peekQuota() ?? await quotaGate()
      if (quota?.exhausted === true) {
        writeOpenAIError(res, 429, 'quota_exhausted',
          '豆包额度已用尽。请等待额度窗口重置，或在豆包客户端中查看额度状态。')
        return
      }

      // ---- conversation continuity ------------------------------------
      //
      // The Harness sends the WHOLE transcript each turn, so the delta is what
      // this turn adds. A continuation sends only that delta plus the id the
      // server issued last time; anything uncertain starts a new conversation,
      // which is the previous behaviour and never worse.
      const sessionKey = sessionKeyOf(parsed.messages)
      const known = sessions.get(sessionKey)
      // ---- circuit valve ------------------------------------------------
      const cooldown = sessionKey !== undefined ? recentFailures.get(sessionKey) : undefined
      if (cooldown !== undefined && cooldown.count >= CIRCUIT_FAILURES && Date.now() < cooldown.until) {
        const waitSec = Math.ceil((cooldown.until - Date.now()) / 1000)
        writeOpenAIError(res, 429, 'RATE_LIMIT', `豆包已连续失败 ${cooldown.count} 次，暂停发送 ${waitSec} 秒以避免继续消耗积分；稍后重试即可。`)
        return
      }
      // Image turns run standalone under `imageGen`; reusing a prior text or task
      // conversationId carries old mode/refusal context and causes text replies.
      const continuing = !imageModel && isContinuation(parsed.messages, known)
      /**
       * What to send.
       *
       * `+1` accounts for the ASSISTANT reply this turn will add to the thread:
       * the server stores both sides, while the inbound transcript we remember
       * ends at the user message. Without it the next turn would resend last
       * turn's answer as if it were new input.
       */
      const delta = continuing ? continuationDelta(parsed.messages ?? [], known) : []
      // A transcript that grew by only an assistant message leaves nothing to
      // send; fall back to the full prompt rather than 400-ing the request.
      const useDelta = delta.length > 0
      let isContinuationTurn = continuing && useDelta
      const outgoing = useDelta ? delta : (parsed.messages ?? [])
      // IMAGEGEN_SLIM_PROMPT: 生图模型只该看到用户那句描述。
      // 完整上下文（系统提示、工具清单、MCP、技能、历史）会让它先分析"该用哪个工具"，
      // 实测白等 1 分 54 秒才出图。这里只取最后一条 user 消息。
      const promptBody = imageModel
        ? buildImagePrompt(parsed.messages ?? [], outgoing)
        : buildPrompt(outgoing)
      if (!promptBody) {
        writeOpenAIError(res, 400, 'invalid_request', 'no usable message content')
        return
      }
      /**
       * Tool emulation: the declared tools become part of the PROMPT, because
       * Doubao ignores the real `tools` field outright (measured — it answered
       * with its own server-side search skill instead). Never append tool schemas
       * to image-generation prompts, or Doubao replies in text instead of drawing.
       */
      const emulate = !imageModel && emulationOn() && (parsed.tools?.length ?? 0) > 0
      const emulatedContractText = emulate ? buildToolContract(parsed.tools ?? []) : ''
      const prompt = emulate
        ? `${promptBody}${emulatedContractText}`
        : promptBody
      // Diagnosis for "why did it answer something unrelated": the prompt is the
      // only thing we control, so being able to see exactly what went upstream is
      // the difference between debugging and guessing.
      if (process.env.DSH_DOUBAO_DEBUG_PROMPT === '1') {
        const raw = JSON.stringify((parsed.messages ?? []).map((m) => ({
          r: m.role,
          t: flattenContent(m.content).slice(0, 200),
        })))
        const line = `[prompt] model=${String(parsed.model)} chars=${prompt.length} `
          + `tools=${parsed.tools?.length ?? 0} emulate=${emulate} msgs=${(parsed.messages ?? []).length}\n`
          + `RAW=${raw}\n${prompt.slice(0, 2000)}\n---\n`
        process.stderr.write(line)
        try {
          appendFileSync(join(homedir(), '.dsh', 'doubao-prompt.log'), line)
        } catch {
          /* diagnostics must never break the request */
        }
      }
      // ---- cancellation & liveness -------------------------------------
      //
      // Both chat paths share this: an abort reaches the upstream socket, and
      // a stream that stops sending is given up on instead of held forever.
      const { signal, onActivity, clientGone, abortUpstream } = createRequestLifecycle(res)

      const upstreamOptions = {
        ...selectedOptions,
        // Cancellation has to reach the socket, not just our side: without it
        // the upstream turn keeps running to completion after everyone left.
        signal,
        // 「工作任务」 turns dispatch their local workspace commands through the
        // tool_local responder, which can only bridge an operation onto a tool
        // this request DECLARED. Without this the bridge sees an empty list and
        // every task-mode file operation has to be refused.
        ...parsed.tools === undefined ? {} : { declaredTools: parsed.tools },
        ...isContinuationTurn && known !== undefined ? { conversationId: known.conversationId, continueConversation: true } : {},
      }
      /** Record the thread id the server handed back, for the next turn. */
      const remember = (conversationId: string | undefined): void => {
        if (sessionKey !== undefined) recentFailures.delete(sessionKey)
        if (!imageModel && conversationId !== undefined) {
          sessions.remember(sessionKey, conversationId, (parsed.messages?.length ?? 0) + 1)
        }
      }
      // Diagnosis without a debugger: which path this turn took, how much text
      // went upstream, and whether a thread id was reused. Never logs content.
      if (process.env.DSH_DOUBAO_DEBUG_PLAN === '1') {
        process.stderr.write(
          `[plan] continuation=${isContinuationTurn} ` +
          `messages=${parsed.messages?.length ?? 0} ` +
          `sending=${outgoing.length} chars=${prompt.length} ` +
          `conversation=${isContinuationTurn && known !== undefined ? known.conversationId : '(new)'}\n`,
        )
      }

      // What we actually sent upstream: the inbound id run through the
      // catalog, so an unknown id degrades to the default instead of being
      // echoed back as if it had been honoured.
      const sent = findDoubaoModel(parsed.model)
      let cachedPrefixMessages = isContinuationTurn && known !== undefined ? known.messageCount : 0

      if (parsed.stream === false) {
        const chatStartedAt = Date.now()
        let result
        try {
          try {
            result = await chat(prompt, { ...upstreamOptions, credentials })
          } catch (error) {
            if (!isContinuationTurn || !isInvalidParamFailure(error)) throw error
            // Same fallback as the streaming path: a continuation rejected with
            // 710020202 stored nothing server-side, so re-issue this turn as a
            // fresh conversation instead of failing it.
            sessions.forget(sessionKey)
            isContinuationTurn = false
            cachedPrefixMessages = 0
            if (process.env.DSH_DOUBAO_DEBUG_PLAN === '1') {
              process.stderr.write('[plan] continuation rejected (710020202); re-issuing as fresh conversation\\n')
            }
            result = await chat(buildPrompt(parsed.messages ?? []) + emulatedContractText, {
              ...requestOptions(parsed),
              signal,
              credentials,
            })
          }
        } catch (error) {
          statsTracker.recordFailure({
            model: sent.id,
            durationMs: Math.max(0, Date.now() - chatStartedAt),
          })
          abortUpstream(error instanceof Error ? error : undefined)
          if (error instanceof DoubaoUpstreamError && sessionKey !== undefined) bumpFailure(sessionKey)
          if (isContinuationTurn && isInvalidParamFailure(error)) sessions.forget(sessionKey)
          throw error
        }
        const completedAt = Date.now()
        remember(result.conversationId)
        // Same contract as the streaming path: the fence is parsed out of the
        // visible text and becomes tool_calls, never prose the user must read.
        const emulated = emulate
          ? (() => {
              const parsedCalls = parseToolCalls(result.text, parsed.tools ?? [])
              // Task-mode turns deliver their calls through the tool_local
              // responder, not a fence; both are DSH calls and both must reach
              // the harness or the turn reports work it never did.
              return { calls: [...parsedCalls.calls, ...(result.toolCalls ?? [])], text: parsedCalls.text }
            })()
          : { calls: [], text: result.text }
        const content = [
          emulated.text,
          result.images.length > 0 ? await imageMarkdownLocal(result.images) : '',
        ].filter((part) => part !== '').join('\n\n')
        const usage = resolveChatUsage({
          messages: parsed.messages ?? [],
          ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
          ...(emulatedContractText !== '' ? { emulatedContractText } : {}),
          cachedPrefixMessages,
          answerText: content,
          ...(result.reasoningText !== undefined ? { reasoningText: result.reasoningText } : {}),
          ...(emulated.calls.length > 0 ? { toolCalls: emulated.calls } : {}),
        })
        statsTracker.recordSuccess({
          model: sent.id,
          ...(sessionKey !== undefined ? { sessionKey } : {}),
          stream: false,
          continuation: isContinuationTurn,
          usage,
          ttftMs: null,
          durationMs: Math.max(0, completedAt - chatStartedAt),
          decodeMs: 0,
          ...(result.telemetry?.contextWindowUsage !== undefined
            ? { upstreamContextWindow: result.telemetry.contextWindowUsage }
            : {}),
          ...(result.telemetry?.firstPacketCostMs !== undefined
            ? { upstreamFirstPacketMs: result.telemetry.firstPacketCostMs }
            : {}),
          ...(result.telemetry?.ackCostMs !== undefined
            ? { upstreamAckMs: result.telemetry.ackCostMs }
            : {}),
          now: completedAt,
        })
        writeJson(res, 200, {
          id: `doubao-${completedAt}`,
          object: 'chat.completion',
          created: Math.floor(completedAt / 1000),
          // Doubao's reply carries no model identifier we can read back, so
          // this field is a REQUEST-side record and nothing more. The name is
          // repeated in `requested_model` because a bare key like "0" or
          // "seed-lite-7b" means nothing to a reader.
          model: sent.id,
          requested_model: describeRequestedModel(parsed.model),
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: content === '' ? ' ' : content,
              ...(result.reasoningText !== '' ? { reasoning_content: result.reasoningText } : {}),
              ...(emulated.calls.length > 0
                ? {
                    tool_calls: emulated.calls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: emulated.calls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: usage.openai,
        })
        return
      }

      await streamCompletion(
        res, prompt, parsed, upstreamOptions, remember,
        () => sessions.forget(sessionKey),
        emulate,
        { signal, onActivity, clientGone, abortUpstream },
        {
          modelId: sent.id,
          sessionKey,
          isContinuationTurn,
          cachedPrefixMessages,
          emulatedContractText,
          credentials,
        },
      )
    } catch (error) {
      writeFailure(res, error)
    }
  }

  /** Synchronous view of the origin; undefined until the socket is bound. */
  const baseUrlSync = (): string | undefined => {
    const address = server.address()
    if (address === null || typeof address === 'string') return undefined
    return `http://127.0.0.1:${address.port}`
  }

  return {
    baseUrl,
    baseUrlSync,
    token: () => SHARED_SECRET,
    stats: () => statsTracker.snapshot(sessions.size),
    resetStats: () => { statsTracker.reset() },
    async close() {
      await ready.catch(() => {})
      // `server.close()` only stops accepting; it waits for every live
      // connection to end. An in-flight stream (or a keep-alive client between
      // requests) therefore kept `dispose` pending for minutes, so the sockets
      // are dropped explicitly.
      server.closeAllConnections?.()
      // `close()` still resolves only once the last connection is really gone,
      // and a wedged socket must not hold plugin disposal hostage.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        timer.unref?.()
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}