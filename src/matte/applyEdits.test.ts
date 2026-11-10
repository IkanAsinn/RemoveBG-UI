import { describe, expect, it } from 'vitest'
import type { BrushStroke } from '../domain'
import { applyStrokes, compositeRegion, MaskEditor, stampSegment } from './applyEdits'

const W = 64
const H = 48
const filled = (v: number) => new Uint8ClampedArray(W * H).fill(v)
const at = (m: Uint8ClampedArray, x: number, y: number) => m[y * W + x]
const stroke = (mode: BrushStroke['mode'], radius: number, ...pts: Array<[number, number]>): BrushStroke => ({
  mode,
  radius,
  points: pts.map(([x, y]) => ({ x, y })),
})

describe('brush engine (FR-17, FR-18)', () => {
  it('erase clears alpha inside the radius and leaves pixels outside untouched', () => {
    const m = filled(255)
    stampSegment(m, W, H, { x: 32, y: 24 }, { x: 32, y: 24 }, 10, 'erase')
    expect(at(m, 32, 24)).toBe(0)
    expect(at(m, 32 + 8, 24)).toBe(0) // inside
    expect(at(m, 32 + 12, 24)).toBe(255) // outside
    expect(at(m, 32, 24 - 12)).toBe(255)
  })

  it('restore sets alpha opaque', () => {
    const m = filled(0)
    stampSegment(m, W, H, { x: 10, y: 10 }, { x: 10, y: 10 }, 5, 'restore')
    expect(at(m, 10, 10)).toBe(255)
    expect(at(m, 20, 10)).toBe(0)
  })

  it('a segment covers the whole capsule between its points (no gaps on fast drags)', () => {
    const m = filled(255)
    stampSegment(m, W, H, { x: 5, y: 24 }, { x: 58, y: 24 }, 3, 'erase')
    for (let x = 5; x <= 58; x++) expect(at(m, x, 24)).toBe(0)
    expect(at(m, 30, 24 + 6)).toBe(255)
  })

  it('radius is honoured in image pixels from 1 to 200 (clamped outside that)', () => {
    for (const r of [1, 50, 200]) {
      const big = new Uint8ClampedArray(500 * 500).fill(255)
      stampSegment(big, 500, 500, { x: 250, y: 250 }, { x: 250, y: 250 }, r, 'erase')
      // Anti-aliased coverage: the erased area matches the disc area for every radius.
      const area = big.reduce((n, v) => n + (255 - v) / 255, 0)
      expect(area / (Math.PI * r * r)).toBeGreaterThan(0.85)
      expect(area / (Math.PI * r * r)).toBeLessThan(1.15)
    }
    const m = new Uint8ClampedArray(1000 * 1000).fill(255)
    const rect = stampSegment(m, 1000, 1000, { x: 500, y: 500 }, { x: 500, y: 500 }, 999, 'erase')!
    expect(rect.width).toBeLessThanOrEqual(2 * 200 + 3)
  })

  it('strokes past the image bounds are clipped without error', () => {
    const m = filled(255)
    const s = stroke('erase', 30, [-100, -100], [-5, 10], [W + 50, H + 50], [1e6, -1e6])
    expect(() => applyStrokes(m, W, H, [s])).not.toThrow()
    const rect = applyStrokes(filled(255), W, H, [s])!
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(W)
    expect(rect.y + rect.height).toBeLessThanOrEqual(H)
    expect(at(m, 0, 10)).toBe(0) // the in-bounds part of the stroke was applied
    // Entirely off-image strokes touch nothing.
    expect(stampSegment(filled(255), W, H, { x: -500, y: -500 }, { x: -400, y: -500 }, 20, 'erase')).toBeNull()
  })

  it('compositeRegion writes source RGB with the mask as alpha (restore brings back source colour)', () => {
    const src = new Uint8ClampedArray(W * H * 4).fill(0)
    for (let i = 0; i < src.length; i += 4) src.set([200, 100, 50, 255], i)
    const out = src
    const m = filled(0)
    compositeRegion(out, m, null, W, { x: 0, y: 0, width: W, height: H }) // erased everywhere…
    stampSegment(m, W, H, { x: 20, y: 20 }, { x: 20, y: 20 }, 4, 'restore')
    compositeRegion(out, m, null, W, { x: 0, y: 0, width: W, height: H }) // …then restored at (20, 20)
    const i = (20 * W + 20) * 4
    expect([...out.slice(i, i + 4)]).toEqual([200, 100, 50, 255])
    expect(out[(5 * W + 5) * 4 + 3]).toBe(0)
  })
})

describe('MaskEditor', () => {
  const source = () => {
    const s = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < s.length; i += 4) s.set([10, 20, 30, 255], i)
    return s
  }

  it('live stamps match a full replay of the same strokes', () => {
    const base = filled(128)
    const ed = new MaskEditor(W, H, source(), base)
    const s = stroke('erase', 6, [5, 5], [30, 20], [60, 40])
    for (let i = 0; i < s.points.length; i++) ed.stamp(s, i)
    const replay = new Uint8ClampedArray(base)
    applyStrokes(replay, W, H, [s])
    expect(ed.mask).toEqual(replay)
    expect(base[0]).toBe(128) // the auto-removal matte is never mutated
    expect(ed.pixels[(40 * W + 60) * 4 + 3]).toBe(0)
    expect(ed.pixels[(0 * W + 63) * 4 + 3]).toBe(128)
  })

  it("keeps the source image's own transparency", () => {
    const src = source()
    src[3] = 0 // pixel (0, 0) transparent in the source
    const ed = new MaskEditor(W, H, src, filled(255))
    expect(ed.pixels[3]).toBe(0)
    expect(ed.pixels[7]).toBe(255)
    ed.sync([stroke('restore', 3, [0, 0])])
    expect(ed.pixels[3]).toBe(0) // restore brings back the source, including its alpha
  })

  it('sync appends new strokes incrementally and rebuilds from the base on reset/undo', () => {
    const base = filled(255)
    const ed = new MaskEditor(W, H, source(), base)
    const a = stroke('erase', 5, [10, 10])
    const b = stroke('erase', 5, [40, 30])
    const r1 = ed.sync([a])!
    expect(r1.width).toBeLessThan(W) // incremental
    ed.sync([a, b])
    expect(at(ed.mask, 10, 10)).toBe(0)
    expect(at(ed.mask, 40, 30)).toBe(0)
    expect(ed.sync(ed.strokes)).toBeNull()

    const r2 = ed.sync([a])! // undo of b → rebuilt
    expect(r2).toEqual({ x: 0, y: 0, width: W, height: H })
    expect(at(ed.mask, 40, 30)).toBe(255)
    expect(ed.pixels[(30 * W + 40) * 4 + 3]).toBe(255)

    ed.sync([]) // reset edits
    expect(ed.mask).toEqual(base)
  })
})

describe('shared pipeline (FR-19 preview = export)', () => {
  it('live edits (stamp, then edge change) equal renderEdits for the same EditState', async () => {
    const { applyEdge } = await import('./edge')
    const { renderEdits } = await import('./applyEdits')
    const src = () => {
      const s = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < s.length; i += 4) s.set([i % 251, 40, 90, 255], i)
      return s
    }
    const base = new Uint8ClampedArray(W * H)
    for (let y = 10; y < 38; y++) for (let x = 12; x < 52; x++) base[y * W + x] = 255
    const strokes = [stroke('erase', 4, [20, 20], [30, 24]), stroke('restore', 3, [2, 2], [8, 5])]

    // Preview path: built at 50, painted live, then the slider moves to 15 and later 80.
    const ed = new MaskEditor(W, H, src(), base)
    for (const s of strokes) for (let i = 0; i < s.points.length; i++) ed.stamp(s, i)
    ed.commit(strokes)
    ed.setBase(applyEdge(base, W, H, 15))
    expect(ed.pixels).toEqual(renderEdits(src(), base, W, H, { edgeValue: 15, strokes }))
    ed.setBase(applyEdge(base, W, H, 80))
    expect(ed.pixels).toEqual(renderEdits(src(), base, W, H, { edgeValue: 80, strokes }))
    // Strokes stay on top of any edge value: the erased spot is still transparent, the restored one opaque.
    expect(ed.mask[22 * W + 25]).toBe(0)
    expect(ed.mask[3 * W + 5]).toBe(255)
  })
})
