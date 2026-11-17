/**
 * Long-string token estimates are cached by content digest.
 *
 * The pricing path prices the WHOLE inbound transcript on every turn, and the
 * Harness resends it verbatim; a JavaScript char loop over hundreds of kilobytes
 * is event-loop time no other request can use. The cache must not change any
 * answer — only how often the loop runs.
 */
import { describe, expect, it } from 'vitest'
import {
  clearTokenEstimateCache,
  estimateTextTokens,
  tokenEstimateCacheSize,
} from '../src/doubao-tokens.ts'

const long = '这是一段用于计费的中文提示，混有 ASCII 与 数字 12345。'.repeat(400)

describe('token estimate cache', () => {
  it('returns the same number on a repeat read and reuses the entry', () => {
    clearTokenEstimateCache()
    const first = estimateTextTokens(long)
    const second = estimateTextTokens(long)
    expect(first).toBe(second)
    expect(tokenEstimateCacheSize()).toBe(1)
  })

  it('prices a changed tail as a new string, not as the cached prefix', () => {
    clearTokenEstimateCache()
    const before = estimateTextTokens(long)
    const changed = `${long}追加一句。`
    const after = estimateTextTokens(changed)
    expect(after).toBeGreaterThan(before)
    expect(tokenEstimateCacheSize()).toBe(2)
  })

  it('keeps short strings out of the cache and still prices them', () => {
    clearTokenEstimateCache()
    expect(estimateTextTokens('你好')).toBe(2)
    expect(tokenEstimateCacheSize()).toBe(0)
  })

  it('never returns less than the documented 4-chars-per-token floor', () => {
    clearTokenEstimateCache()
    for (const text of ['a', long, `${long}${long}`]) {
      expect(estimateTextTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length / 4))
    }
  })

  it('stays bounded when many distinct long strings pass through', () => {
    clearTokenEstimateCache()
    for (let i = 0; i < 5000; i += 1) {
      estimateTextTokens(`${long}#${i}`)
    }
    expect(tokenEstimateCacheSize()).toBeLessThanOrEqual(4096)
  })
})
