/**
 * The SSE flow-control sink and the quota read's time budget.
 *
 * Both exist because of the same class of bug: something on the request path
 * had NO upper bound. An unbounded write queue eats the host's heap when a
 * client reads slowly; an unbounded quota read stalls turns behind a socket
 * that may never answer. Neither shows up in a functional test, which is why
 * they are pinned here rather than left to the integration suite.
 */
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi, afterEach } from 'vitest'

import { createStreamSink } from '../src/doubao-shim.ts'

/**
 * A response stand-in that can refuse writes on demand.
 *
 * `writableWrite` is what the caller gets back from `write()`: `false` means
 * "the socket's buffer is full", which is the only signal Node gives and the
 * one the sink has to obey.
 */
function fakeResponse(options: { acceptWrites?: boolean } = {}) {
  const emitter = new EventEmitter() as unknown as ServerResponse & {
    written: string[]
    acceptWrites: boolean
    writableEnded: boolean
    destroyed: boolean
  }
  const target = emitter as unknown as {
    written: string[]
    acceptWrites: boolean
    writableEnded: boolean
    destroyed: boolean
    write: (text: string) => boolean
  }
  target.written = []
  target.acceptWrites = options.acceptWrites !== false
  target.writableEnded = false
  target.destroyed = false
  target.write = (text: string): boolean => {
    target.written.push(text)
    return target.acceptWrites
  }
  return target
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createStreamSink', () => {
  it('sends the first chunk at once and coalesces the rest of the tick', async () => {
    const res = fakeResponse()
    const sink = createStreamSink(res, { heartbeatMs: 0 })
    sink.write('a')               // fast path: nothing pending, goes out now
    sink.write('b')               // same tick: held for the batch
    sink.write('c')
    expect(res.written).toEqual(['a'])
    // One microtask later the held chunks leave as a SINGLE write, which is the
    // whole point (each `res.write` costs a syscall + a chunked frame).
    await Promise.resolve()
    expect(res.written).toEqual(['a', 'bc'])
    sink.dispose()
  })

  it('coalesces a queued batch on drain, and flush() empties it synchronously', () => {
    const res = fakeResponse()
    const sink = createStreamSink(res, { heartbeatMs: 0 })
    res.acceptWrites = false
    sink.write('first')          // taken by write(), socket now "full"
    sink.write('second')         // must be queued, not lost
    sink.write('third')
    expect(res.written).toEqual(['first'])

    res.acceptWrites = true
    res.emit('drain')
    expect(res.written).toEqual(['first', 'secondthird'])

    sink.write('tail')
    sink.flush()
    expect(res.written).toEqual(['first', 'secondthird', 'tail'])
    sink.dispose()
  })

  it('flush() hands a queued batch to a stalled socket instead of dropping it', () => {
    const res = fakeResponse()
    const sink = createStreamSink(res, { heartbeatMs: 0 })
    res.acceptWrites = false
    sink.write('first')
    sink.write('second')
    sink.write('third')
    // The socket is still "full", but the turn is ending: flush must write anyway.
    sink.flush()
    expect(res.written).toEqual(['first', 'secondthird'])
    sink.dispose()
  })

  it('reports an overflow instead of buffering without a ceiling', () => {
    const res = fakeResponse()
    const seen: Error[] = []
    const sink = createStreamSink(res, {
      heartbeatMs: 0,
      maxQueuedBytes: 4,
      onOverflow: (error) => seen.push(error),
    })
    res.acceptWrites = false
    sink.write('x'.repeat(4))    // socket refuses this one
    sink.write('x'.repeat(8))    // would exceed the 8-byte ceiling
    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toContain('中止本轮')
    // The queue is dropped, not handed to a socket that already gave up.
    res.acceptWrites = true
    res.emit('drain')
    expect(res.written).toHaveLength(1)
    sink.dispose()
  })

  it('emits an SSE comment after a silent interval', () => {
    vi.useFakeTimers()
    const res = fakeResponse()
    const sink = createStreamSink(res, { heartbeatMs: 1000 })
    sink.write('data: x\n\n')
    vi.advanceTimersByTime(1200)
    // A `: ` line is a legal no-op: the OpenAI SDK's decoder returns null for
    // it, so it refreshes the client's idle watchdog without inventing a chunk.
    expect(res.written).toEqual(['data: x\n\n', ': keepalive\n\n'])
    sink.dispose()
  })

  it('does not beat while the socket is backed up', () => {
    vi.useFakeTimers()
    const res = fakeResponse()
    const sink = createStreamSink(res, { heartbeatMs: 1000 })
    res.acceptWrites = false
    sink.write('data: x\n\n')
    vi.advanceTimersByTime(5000)
    expect(res.written).toEqual(['data: x\n\n'])
    sink.dispose()
  })

  it('stops beating once disposed', () => {
    vi.useFakeTimers()
    const res = fakeResponse()
    const sink = createStreamSink(res, { heartbeatMs: 1000 })
    sink.dispose()
    vi.advanceTimersByTime(5000)
    expect(res.written).toEqual([])
  })
})
