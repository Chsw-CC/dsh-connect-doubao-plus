/**
 * A risk challenge on the direct path must not end the turn while the official
 * page can still answer it — measured 2026-11-26: the direct path was refused
 * while the same account answered normally through the page.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { streamChat } from '../src/doubao-upstream.ts'

const relay = vi.hoisted(() => ({ available: true, calls: 0 }))

vi.mock('../src/doubao-browser-relay.ts', () => ({
  browserRelayEnabled: () => false,
  browserRelayAvailable: () => relay.available,
  browserRelayChat: async () => {
    relay.calls += 1
    const frame = (event: string, data: unknown): string =>
      `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    return new Response(
      frame('SSE_ACK', { ack_client_meta: { conversation_id: 'c1' } })
      + frame('STREAM_CHUNK', { content: { content_block: [{ block_type: 10000, content: { text_block: { text: 'from-page' } } }] } })
      + frame('SSE_REPLY_END', {}),
      { status: 200 },
    )
  },
}))

const credentials: DoubaoCredentials = {
  ok: true,
  header: 'sessionid=test',
  pairs: new Map(REQUIRED_COOKIE_NAMES.map(name => [name, 'test-value'])),
}

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'doubao-rescue-'))
  process.env.DSH_DOUBAO_RISK_STATE_PATH = join(directory, 'circuit.json')
  process.env.DSH_DOUBAO_RISK_COOLDOWN_MS = '0'
  process.env.DSH_DOUBAO_MIN_INTERVAL_MS = '0'
  delete process.env.DSH_DOUBAO_TASK
  delete process.env.DSH_DOUBAO_BROWSER_RELAY
  relay.available = true
  relay.calls = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
  for (const key of ['DSH_DOUBAO_RISK_STATE_PATH', 'DSH_DOUBAO_RISK_COOLDOWN_MS', 'DSH_DOUBAO_MIN_INTERVAL_MS', 'DSH_DOUBAO_TASK', 'DSH_DOUBAO_BROWSER_RELAY']) delete process.env[key]
})

function challenge(): Response {
  return new Response(
    'id: 1\nevent: STREAM_ERROR\ndata: ' + JSON.stringify({ error_code: 710022004, error_msg: 'rate limit' }) + '\n\n',
    { status: 200 },
  )
}

describe('automatic fallback to the official page', () => {
  it('answers through the page instead of failing the turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => challenge()))
    const result = await streamChat('hello', { credentials })
    expect(result.text).toBe('from-page')
    expect(relay.calls).toBe(1)
  })

  it('does not touch the page when it is unavailable', async () => {
    relay.available = false
    vi.stubGlobal('fetch', vi.fn(async () => challenge()))
    await expect(streamChat('hello', { credentials })).rejects.toMatchObject({ code: 710022004 })
    expect(relay.calls).toBe(0)
  })

  it('never falls back for a turn that already streamed text', async () => {
    const partial = 'id: 1\nevent: STREAM_CHUNK\ndata: '
      + JSON.stringify({ content: { content_block: [{ block_type: 10000, content: { text_block: { text: 'partial' } } }] } })
      + '\n\nid: 2\nevent: STREAM_ERROR\ndata: ' + JSON.stringify({ error_code: 710022004 }) + '\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(partial, { status: 200 })))
    await expect(streamChat('hello', { credentials })).rejects.toMatchObject({ code: 710022004 })
    expect(relay.calls).toBe(0)
  })
})