import { afterEach, describe, expect, it, vi } from 'vitest'

import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { streamChat } from '../src/doubao-upstream.ts'

const credentials: DoubaoCredentials = {
  ok: true,
  header: 'sessionid=test',
  pairs: new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, 'test-value'])),
}

function frame(event: string, data: unknown): string {
  return 'id: 1\nevent: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
}

const cancelled = { count: 0 }

/** A 200 SSE body that delivers the chunks, then never settles another read. */
function stallingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index] as string))
        index += 1
        return
      }
      return new Promise<void>(() => {})
    },
    cancel() {
      cancelled.count += 1
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ACK = frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-1' } })

afterEach(() => {
  vi.unstubAllGlobals()
  cancelled.count = 0
})

describe('stopping an in-flight turn', () => {
  it('settles on abort instead of hanging forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stallingResponse([ACK])))
    const controller = new AbortController()
    const turn = streamChat('hi', { credentials, signal: controller.signal })
    // Park the loop inside reader.read(), which never settles on its own.
    await new Promise((resolve) => setTimeout(resolve, 25))

    const state = { settled: false }
    void turn.then(
      () => { state.settled = true },
      () => { state.settled = true },
    )
    controller.abort()
    // Long enough for the abort listener to run and the body to be cancelled:
    // if the signal is ignored, this stays false for the rest of the process.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(state.settled).toBe(true)
  })
})
