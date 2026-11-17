/**
 * The generated-picture cache: what gets saved, what gets refused, what gets
 * deleted.
 *
 * Three properties are pinned here, all of them failure modes that used to be
 * unbounded:
 *
 *   1. a picture is streamed to a `.part` file and only renamed when complete,
 *      so a dropped connection never leaves a truncated image under a name that
 *      looks finished;
 *   2. one oversized response cannot fill the disk — the size cap aborts the
 *      download and the URL stays in its place;
 *   3. the directory as a whole is bounded, by age and by total size, because
 *      nothing else ever visits it.
 */
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { imageCacheDir, imageMarkdownLocal, pruneImageCache } from '../src/doubao-shim.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doubao-images-'))
  vi.stubEnv('DSH_DOUBAO_IMAGES_DIR', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** A response whose body is `bytes` bytes, delivered in one chunk. */
function bodyResponse(bytes: number, status = 200): Response {
  return new Response(new Uint8Array(bytes).fill(7), {
    status,
    headers: { 'content-type': 'image/png' },
  })
}

const images = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://cdn.invalid/${i + 1}.jpeg`,
    width: 1024,
    height: 1024,
  }))

describe('saving a generated picture', () => {
  it('honours the directory override and returns a local path', async () => {
    expect(imageCacheDir()).toBe(dir)
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse(1024)))
    const markdown = await imageMarkdownLocal(images(1) as never)
    expect(markdown).toContain(dir.replace(/\\/g, '/'))
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^doubao-.+-1\.png$/)
    expect(files[0]?.endsWith('.part')).toBe(false)
  })

  it('keeps the remote URL when the download is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse(0, 404)))
    const markdown = await imageMarkdownLocal(images(1) as never)
    expect(markdown).toBe('![豆包生图 1](https://cdn.invalid/1.jpeg)')
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('refuses an oversized picture and leaves no partial file behind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse(4096)))
    const markdown = await imageMarkdownLocal(images(1) as never, { maxBytes: 1024 })
    expect(markdown).toBe('![豆包生图 1](https://cdn.invalid/1.jpeg)')
    // The `.part` file must not survive the abort.
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('saves at most eight pictures and links the rest by URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse(64)))
    const markdown = await imageMarkdownLocal(images(10) as never)
    // Local entries end in `.png`; the two beyond the cap keep their `.jpeg` URL.
    expect((markdown.match(/\.png/g) ?? []).length).toBe(8)
    expect(markdown).toContain('![豆包生图 9](https://cdn.invalid/9.jpeg)')
    expect(markdown).toContain('![豆包生图 10](https://cdn.invalid/10.jpeg)')
    expect(readdirSync(dir)).toHaveLength(8)
  })
})

describe('pruning the cache', () => {
  function seed(name: string, bytes: number, ageMs: number): string {
    const path = join(dir, name)
    writeFileSync(path, Buffer.alloc(bytes, 1))
    const when = new Date(Date.now() - ageMs)
    utimesSync(path, when, when)
    return path
  }

  it('removes entries past the age limit', async () => {
    seed('doubao-old-1.png', 16, 40 * 24 * 60 * 60 * 1000)
    seed('doubao-new-1.png', 16, 0)
    const result = await pruneImageCache()
    expect(result.removed).toBe(1)
    expect(readdirSync(dir)).toEqual(['doubao-new-1.png'])
  })

  it('trims total size oldest-first, and never touches foreign files', async () => {
    seed('doubao-a-1.png', 400, 3_000)
    seed('doubao-b-1.png', 400, 2_000)
    seed('doubao-c-1.png', 400, 1_000)
    seed('notes.txt', 400, 5_000)
    const result = await pruneImageCache({ maxBytes: 500 })
    expect(result.removed).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['doubao-c-1.png', 'notes.txt'])
  })

  it('reports the surviving byte total and tolerates a missing directory', async () => {
    seed('doubao-a-1.png', 100, 0)
    const result = await pruneImageCache()
    expect(result).toEqual({ removed: 0, keptBytes: 100 })
    expect(await pruneImageCache({ dir: join(dir, 'absent') })).toEqual({ removed: 0, keptBytes: 0 })
  })
})
