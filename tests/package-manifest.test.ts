/**
 * The manifest is what every install path reads first.
 *
 * A merge once dropped `name`/`displayName`/`description` from package.json
 * while leaving a valid `version`; nothing failed until the built tarball was
 * handed to `dsh plugin add`, which refused it with
 * `ERR_PNPM_MISSING_PACKAGE_NAME`. A gate that reads the same file the installer
 * reads turns that into a red test instead of a broken release.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

describe('package.json identity', () => {
  it('names the plugin by its installed id', () => {
    // Must match the directory name and the id in cordis.patch.yml, or the host
    // loads the entry under a name nothing else agrees with.
    expect(manifest.name).toBe('dsh-connect-doubao-plus')
  })

  it('keeps a human-facing name and a description', () => {
    expect(typeof manifest.displayName).toBe('string')
    expect((manifest.displayName as string).length).toBeGreaterThan(0)
    expect(typeof manifest.description).toBe('string')
    expect((manifest.description as string).length).toBeGreaterThan(20)
  })

  it('declares a semver version', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
