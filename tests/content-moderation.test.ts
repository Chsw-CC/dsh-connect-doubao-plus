/**
 * Content moderation is NOT the risk-control slider and NOT a broken upstream.
 *
 * These tests pin three things:
 *  - the notice is recognised (and a reply that merely EXPLAINS it is not);
 *  - it surfaces as `content_blocked`, never retried;
 *  - the user gets an actionable message (change wording / report a false positive).
 */
import { describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import {
  classifyDoubaoFailure,
  describeDoubaoFailure,
  isContentModerationNotice,
  isRetryableFailure,
  streamChat,
} from '../src/doubao-upstream.ts'
import { errorCodeFor } from '../src/doubao-shim.ts'

const NOTICE = '该内容涉嫌违反豆包使用规范，若有误判，请长按本条消息后点击“反馈与举报”进行反馈。'

const credentials: DoubaoCredentials = {
  ok: true,
  header: 'sessionid=test',
  pairs: new Map(REQUIRED_COOKIE_NAMES.map(name => [name, 'test-value'])),
}

function frame(event: string, data: unknown): string {
  return `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const ACK = frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-1' } })
const END = frame('SSE_REPLY_END', {})

function chunk(text: string): string {
  return frame('STREAM_CHUNK', {
    content: { content_block: [{ block_type: 10000, content: { text_block: { text } } }] },
  })
}

describe('content moderation', () => {
  it('recognises the notice and ignores a reply that only explains it', () => {
    expect(isContentModerationNotice(NOTICE)).toBe(true)
    // A model quoting the notice inside a real answer must stay an answer.
    expect(isContentModerationNotice(
      '这是豆包的内容审核提示。它表示这句话被判定为违反了使用规范，你可以点「反馈与举报」申诉。',
    )).toBe(false)
    expect(isContentModerationNotice('普通回答，没有审核提示。')).toBe(false)
    expect(isContentModerationNotice('')).toBe(false)
    expect(isContentModerationNotice(NOTICE.repeat(6))).toBe(false)
  })

  it('reports a STREAM_ERROR notice as content_blocked, with no retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      frame('STREAM_ERROR', { error_code: 710010801, error_msg: NOTICE }),
      { status: 200 },
    )))

    const error = await streamChat('hello', { credentials }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kindHint: 'content_blocked' })
    expect(classifyDoubaoFailure(error as never)).toBe('content_blocked')
    expect(isRetryableFailure(error)).toBe(false)
    expect(errorCodeFor('content_blocked', false)).toBe('CONTENT_BLOCKED')
    const hint = describeDoubaoFailure(error)
    expect(hint).toContain('反馈与举报')
    expect(hint).toContain('换一种表达')
    vi.unstubAllGlobals()
  })

  it('reports a notice delivered as ordinary reply text instead of returning it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ACK + chunk(NOTICE) + END, { status: 200 })))

    const error = await streamChat('hello', { credentials }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kindHint: 'content_blocked' })
    expect(String((error as Error).message)).toContain('内容审核')
    vi.unstubAllGlobals()
  })

  it('keeps a normal answer that quotes the notice', async () => {
    const answer = '你看到的提示意思是：这条消息被判定为涉嫌违规，可以走「反馈与举报」申诉。'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ACK + chunk(answer) + END, { status: 200 })))

    const result = await streamChat('hello', { credentials })
    expect(result.text).toBe(answer)
    vi.unstubAllGlobals()
  })
})
