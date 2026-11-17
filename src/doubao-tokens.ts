/**
 * Deterministic token estimation and OpenAI-compatible usage accounting for
 * Doubao shim responses.
 *
 * WHY ESTIMATED ON-SHIM. Doubao's `/chat/completion` endpoint emits optional
 * server-side `context_window_usage` snapshots inside `Agent-GeneralTask` turns
 * (covering Doubao's own hidden workspace prompt + built-in tool schemas), but
 * does not report per-request OpenAI `prompt_tokens` / `completion_tokens` or
 * plain-chat token counts.
 *
 * Computing OpenAI `usage` from DSH's actual inbound `messages` / `tools` and
 * the streamed `reasoning` + `text` + emulated `tool_calls` ensures:
 *
 *   1. DSH's native `tokenUsage`, `contextPressure`, `ContextMeter`,
 *      `UsagePill`, `sessionStats`, `ActivityPill`, and `StatsView` populate
 *      reliably across all Doubao models (chat, deep-think, task 2.1, image);
 *   2. CJK text (~1 tok/char) and ASCII code/prose (~3.7 chars/tok) are priced
 *      realistically while mathematically staying >= DSH's 4-chars/token floor
 *      (`@deepseek-ai/dsh-token-meter`), so `TokenMeter.measure()` accepts the
 *      reported `usage` instead of falling back to heuristic mode;
 *   3. Server-side `conversation_id` continuations surface the already-uploaded
 *      transcript prefix honestly as `prompt_tokens_details.cached_tokens`.
 *
 * @module dsh-connect-doubao-plus/tokens
 */

import { createHash } from 'node:crypto'

export interface TokenizableToolCall {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: unknown
  }
}

export interface TokenizableMessage {
  role?: string
  content?: unknown
  name?: string
  tool_call_id?: string
  tool_calls?: readonly TokenizableToolCall[]
}

export interface TokenizableTool {
  type?: string
  function?: {
    name?: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens: number
  }
  completion_tokens_details?: {
    reasoning_tokens: number
  }
}

export interface UsageBreakdown {
  promptTokens: number
  uncachedInputTokens: number
  cachedInputTokens: number
  completionTokens: number
  reasoningTokens: number
  answerTokens: number
  toolCallTokens: number
  totalTokens: number
  openai: OpenAIUsage
}

export interface ResolveChatUsageInput {
  messages: readonly TokenizableMessage[]
  tools?: readonly TokenizableTool[]
  /** Tool contract prose appended when tool emulation is active. */
  emulatedContractText?: string
  /** Leading message count already resident on upstream `conversation_id`. */
  cachedPrefixMessages?: number
  answerText: string
  reasoningText?: string
  toolCalls?: ReadonlyArray<{ name: string; arguments: string }>
}

const MESSAGE_OVERHEAD_TOKENS = 4
const REPLY_PRIMING_TOKENS = 2
const IMAGE_PART_TOKENS = 256
const TOOLS_OVERHEAD_TOKENS = 4

function isCjkOrFullwidth(code: number): boolean {
  return (
    (code >= 0x2E80 && code <= 0x30FF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFF00 && code <= 0xFFEF)
  )
}

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5A) ||
    (code >= 0x61 && code <= 0x7A) ||
    code === 0x5F
  )
}

/**
 * Single-pass O(n) token count estimator tuned for mixed Chinese/English/code.
 *
 * Every code-unit weight is >= 0.25, guaranteeing `estimateTextTokens(s) >=
 * Math.ceil(s.length / 4)` for any non-empty string.
 */
function countTextTokens(text: string): number {
  let score = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // Astral / emoji surrogate pairs (~2 tokens per glyph).
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        score += 2
        i += 1
        continue
      }
    }
    if (code <= 0x20) {
      score += 0.25
    } else if (isAsciiWordChar(code)) {
      score += 0.27
    } else if (isCjkOrFullwidth(code)) {
      score += 1
    } else if (code < 0x80) {
      score += 0.6
    } else {
      score += 0.75
    }
  }
  return Math.max(1, Math.ceil(score))
}

/**
 * Results for long strings, keyed by a digest of the text itself.
 *
 * WHY. Every turn prices the WHOLE inbound transcript, and the Harness resends
 * it verbatim: on a long agent session that is hundreds of kilobytes re-scanned
 * by a JavaScript char loop on every request — tens of milliseconds of the
 * event loop that no other request can use. The content is identical between
 * turns except for the tail, so the count is cacheable.
 *
 * The key is a SHA-1 of the text rather than the text itself: hashing is native
 * (an order of magnitude faster than the loop) and the cache then holds 40-byte
 * keys instead of megabyte strings. SHA-1 is used purely as a fingerprint here
 * — a collision would mis-price one message, the adversarial case for a hash
 * choice that a token estimate does not present.
 *
 * Short strings skip the cache: the digest costs more than the count, and they
 * are re-read a handful of code units at a time.
 */
const TEXT_COUNT_CACHE_MAX = 4096
const TEXT_COUNT_CACHE_MIN_LENGTH = 256
const textCountCache = new Map<string, number>()

/** Visible for tests and for a future /stats counter; not part of the pricing path. */
export function tokenEstimateCacheSize(): number {
  return textCountCache.size
}

/** Drop cached counts. Only needed by tests that pin exact cache behaviour. */
export function clearTokenEstimateCache(): void {
  textCountCache.clear()
}

/**
 * Count tokens for a string, reusing a digest-keyed result for long inputs.
 *
 * The returned number is identical to `countTextTokens(text)`: the cache sits
 * in front of the loop and never changes the answer.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0
  if (text.length < TEXT_COUNT_CACHE_MIN_LENGTH) return countTextTokens(text)
  const key = createHash('sha1').update(text).digest('base64url')
  const cached = textCountCache.get(key)
  if (cached !== undefined) {
    // Re-insert so the eviction order is least-recently-USED, not oldest-first.
    textCountCache.delete(key)
    textCountCache.set(key, cached)
    return cached
  }
  const value = countTextTokens(text)
  textCountCache.set(key, value)
  while (textCountCache.size > TEXT_COUNT_CACHE_MAX) {
    const oldest = textCountCache.keys().next().value
    if (oldest === undefined) break
    textCountCache.delete(oldest)
  }
  return value
}

/** Estimate tokens for an inbound OpenAI message `content` field. */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (content === null || content === undefined) return 0
  if (Array.isArray(content)) {
    let tokens = 0
    for (const part of content) {
      if (part === null || part === undefined) continue
      if (typeof part === 'string') {
        tokens += estimateTextTokens(part) + 2
        continue
      }
      if (typeof part === 'object') {
        const record = part as Record<string, unknown>
        if (record.type === 'image_url' || record.type === 'image') {
          tokens += IMAGE_PART_TOKENS
          continue
        }
        if (typeof record.text === 'string') {
          tokens += estimateTextTokens(record.text) + 2
          continue
        }
      }
      tokens += estimateTextTokens(JSON.stringify(part))
    }
    return tokens
  }
  return estimateTextTokens(JSON.stringify(content))
}

/** Estimate tokens for one OpenAI chat message including role & tool calls. */
export function estimateMessageTokens(message: TokenizableMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content)
  if (typeof message.name === 'string' && message.name !== '') {
    tokens += estimateTextTokens(message.name) + 1
  }
  if (typeof message.tool_call_id === 'string' && message.tool_call_id !== '') {
    tokens += estimateTextTokens(message.tool_call_id) + 1
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fnName = call.function?.name ?? ''
      const rawArgs = call.function?.arguments
      const fnArgs = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? '')
      tokens += 4 + estimateTextTokens(fnName) + estimateTextTokens(fnArgs)
    }
  }
  return tokens
}

/** Estimate tokens consumed by tool definitions or their emulated prompt block. */
export function estimateToolsTokens(
  tools: readonly TokenizableTool[] | undefined,
  emulatedContractText?: string,
): number {
  const schemaTokens = !Array.isArray(tools) || tools.length === 0
    ? 0
    : estimateTextTokens(JSON.stringify(tools)) + TOOLS_OVERHEAD_TOKENS
  const contractTokens = emulatedContractText !== undefined && emulatedContractText !== ''
    ? estimateTextTokens(emulatedContractText) + TOOLS_OVERHEAD_TOKENS
    : 0
  return Math.max(schemaTokens, contractTokens)
}

/** Build full usage metrics + OpenAI wire `usage` payload for one chat completion. */
export function resolveChatUsage(input: ResolveChatUsageInput): UsageBreakdown {
  const messages = Array.isArray(input.messages) ? input.messages : []
  let messagesTokens = 0
  let prefixTokens = 0
  const cachedPrefix = input.cachedPrefixMessages ?? 0
  const useCachedPrefix = cachedPrefix > 0 && cachedPrefix < messages.length

  for (let i = 0; i < messages.length; i += 1) {
    const msgTokens = estimateMessageTokens(messages[i] ?? {})
    messagesTokens += msgTokens
    if (useCachedPrefix && i < cachedPrefix) {
      prefixTokens += msgTokens
    }
  }

  const toolsTokens = estimateToolsTokens(input.tools, input.emulatedContractText)
  const promptTokens = messagesTokens + toolsTokens + (messages.length > 0 ? REPLY_PRIMING_TOKENS : 0)
  const cachedInputTokens = useCachedPrefix
    ? Math.min(prefixTokens, Math.max(0, promptTokens - MESSAGE_OVERHEAD_TOKENS))
    : 0
  const uncachedInputTokens = Math.max(0, promptTokens - cachedInputTokens)

  const reasoningTokens = input.reasoningText !== undefined && input.reasoningText !== ''
    ? estimateTextTokens(input.reasoningText)
    : 0
  const answerTokens = input.answerText !== ''
    ? estimateTextTokens(input.answerText)
    : 0
  let toolCallTokens = 0
  if (Array.isArray(input.toolCalls)) {
    for (const call of input.toolCalls) {
      toolCallTokens += 4 + estimateTextTokens(call.name) + estimateTextTokens(call.arguments)
    }
  }
  const completionTokens = reasoningTokens + answerTokens + toolCallTokens
  const totalTokens = promptTokens + completionTokens

  const openai: OpenAIUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(cachedInputTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedInputTokens } } : {}),
    ...(reasoningTokens > 0 ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
  }

  return {
    promptTokens,
    uncachedInputTokens,
    cachedInputTokens,
    completionTokens,
    reasoningTokens,
    answerTokens,
    toolCallTokens,
    totalTokens,
    openai,
  }
}
