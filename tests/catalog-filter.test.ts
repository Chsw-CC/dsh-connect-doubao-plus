/**
 * Which entries the model picker may offer.
 *
 * The bug this file exists for was invisible in every end-to-end test: the
 * settings card showed a model UNTICKED, the file on disk agreed, and the DSH
 * picker offered it anyway. The filter kept every id the static catalog had
 * never heard of -- seven of them, on the menu this was measured against -- so
 * the checkboxes for exactly those models did nothing.
 *
 * "Unticked means absent" is the whole contract of a checkbox, and it has to
 * hold for discovered ids too. That is what is pinned here.
 */
import { describe, expect, it } from 'vitest'

import { DOUBAO_MODELS, enabledModelsOf, type DoubaoModelInfo } from '../src/doubao-catalog.ts'

/** A discovered id: present on the real menu, absent from the static catalog. */
const DISCOVERED_A: DoubaoModelInfo = { id: 'person-glm-5-3-261111', name: 'GLM 5.3', reasoning: true }
const DISCOVERED_B: DoubaoModelInfo = {
  id: 'person-kimi-k3-1-pro-high speed-261111'.replace(' high speed', '-highspeed'),
  name: 'Kimi K3.1 Pro 高速',
  reasoning: true,
}

function catalogOf(...extra: DoubaoModelInfo[]): DoubaoModelInfo[] {
  return [...DOUBAO_MODELS, ...extra]
}

describe('enabledModelsOf', () => {
  it('serves the whole catalog when never configured', () => {
    // `undefined` is "the user never saved a checklist". A first-run install must
    // still see models, so this is NOT read as "ticked none".
    const catalog = catalogOf(DISCOVERED_A)
    expect(enabledModelsOf(undefined, catalog)).toHaveLength(catalog.length)
  })

  it('serves the whole catalog for `undefined` (never saved) and nothing for []', () => {
    // The two states are now distinct, and `withStoredSettings` is what keeps
    // them apart: the schema's `[]` default (a never-saved install) is folded to
    // `undefined` there, while a `[]` that came from the settings FILE means the
    // user ticked nothing and must be honoured.
    const catalog = catalogOf(DISCOVERED_A)
    expect(enabledModelsOf(undefined, catalog)).toHaveLength(catalog.length)
    expect(enabledModelsOf([], catalog)).toHaveLength(0)
  })

  it('keeps only the ticked ids', () => {
    const picked = enabledModelsOf(['5', 'image-gen'], catalogOf(DISCOVERED_A))
    expect(picked.map((model) => model.id)).toEqual(['5', 'image-gen'])
  })

  it('DROPS a discovered model the user unticked', () => {
    // The regression. DISCOVERED_A is not in the static catalog, so the old
    // `|| !known.has(id)` clause waved it through no matter what the user ticked.
    const picked = enabledModelsOf(['5', 'image-gen'], catalogOf(DISCOVERED_A, DISCOVERED_B))
    const ids = picked.map((model) => model.id)
    expect(ids).not.toContain(DISCOVERED_A.id)
    expect(ids).not.toContain(DISCOVERED_B.id)
  })

  it('still offers a discovered model the user DID tick', () => {
    // The protection the old clause was reaching for, without the collateral:
    // a model the static catalog does not know is selectable as soon as it is
    // ticked. The card ticks it for us (it seeds the draft from the catalog it
    // just read), so a new Doubao release is still visible on first sight.
    const picked = enabledModelsOf(['5', DISCOVERED_A.id], catalogOf(DISCOVERED_A))
    expect(picked.map((model) => model.id)).toEqual(['5', DISCOVERED_A.id])
  })

  it('drops ids that no longer exist in the catalog', () => {
    // The menu can retire a model while the saved list still names it.
    const picked = enabledModelsOf(['5', 'retired-model'], [
      { id: '5', name: '豆包 2.1 Pro', reasoning: true },
    ])
    expect(picked.map((model) => model.id)).toEqual(['5'])
  })

  it('preserves catalog order rather than tick order', () => {
    const picked = enabledModelsOf(['9', '5'], [
      { id: '5', name: '豆包 2.1 Pro', reasoning: true },
      { id: '9', name: '自动', reasoning: true },
    ])
    expect(picked.map((model) => model.id)).toEqual(['5', '9'])
  })
})
