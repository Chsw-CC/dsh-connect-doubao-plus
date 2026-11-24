/**
 * One identity for BOTH modes.
 *
 * The task path used to keep the frozen desktop identity (aid=582478, shared
 * device_id, SamanthaDoubao UA) while the session was a web one — the exact
 * mismatch risk control compares. A task turn must now carry the captured web
 * identity, and a task with no captured identity must still not invent one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { streamChat } from '../src/doubao-upstream.ts'

const credentials: DoubaoCredentials = {
  ok: true,
  header: 'sessionid=test',
  pairs: new Map(REQUIRED_COOKIE_NAMES.map(name => [name, 'test-value'])),
}

function frame(event: string, data: unknown): string {
  return `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const OK = frame('SSE_ACK', { ack_client_meta: { conversation_id: 'c1' } })
  + frame('STREAM_CHUNK', { content: { content_block: [{ block_type: 10000, content: { text_block: { text: 'ok' } } }] } })
  + frame('SSE_REPLY_END', {})

let home = ''
let saved: Record<string, string | undefined> = {}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-identity-'))
  saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = home
  process.env.HOME = home
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(join(home, '.dsh', 'doubao-browser-fingerprint.json'), JSON.stringify({
    userAgent: 'Mozilla/5.0 Chrome/157 TestAgent',
    referer: 'https://www.doubao.com/chat/',
    secChUa: '"Chromium";v="157"',
    query: { aid: '497858', real_aid: '497858', device_id: '7123456789', device_platform: 'web', web_platform: 'desktop', samantha_web: '1', doubao_pc_version: '2.31.4' },
  }), 'utf8')
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  for (const key of ['USERPROFILE', 'HOME'] as const) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

async function capturedChatRequest(taskMode: boolean): Promise<{ url: string; headers: Record<string, string> }> {
  const fetchMock = vi.fn(async () => new Response(OK, { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  await streamChat('hi', { credentials, taskMode })
  const call = fetchMock.mock.calls.find(entry => String(entry[0]).includes('/chat/completion'))
  expect(call).toBeDefined()
  vi.unstubAllGlobals()
  return {
    url: String(call![0]),
    headers: (call![1] as { headers: Record<string, string> }).headers,
  }
}

describe('unified request identity', () => {
  it('sends the captured web identity on a plain turn', async () => {
    const request = await capturedChatRequest(false)
    expect(request.url).toContain('aid=497858')
    expect(request.url).not.toContain('582478')
    expect(request.headers['User-Agent']).toContain('TestAgent')
  })

  it('sends the same identity on a 工作任务 turn', async () => {
    const request = await capturedChatRequest(true)
    expect(request.url).toContain('aid=497858')
    expect(request.url).toContain('device_platform=web')
    expect(request.url).not.toContain('582478')
    expect(request.url).not.toContain('pc_client')
    expect(request.headers['User-Agent']).toContain('TestAgent')
    expect(request.headers['User-Agent']).not.toContain('SamanthaDoubao')
    expect(request.headers.Referer).toBe('https://www.doubao.com/chat/')
  })
})