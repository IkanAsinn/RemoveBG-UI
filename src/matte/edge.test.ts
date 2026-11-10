import { describe, expect, it } from 'vitest'
import { applyEdge, edgeMaxRadius, edgeRadii } from './edge'

const W = 100
const H = 80
/** Hard-edged opaque square [30, 70) × [20, 60) on transparent. */
function square() {
  const m = new Uint8ClampedArray(W * H)
  for (let y = 20; y < 60; y++) for (let x = 30; x < 70; x++) m[y * W + x] = 255
  return m
}
const row = (m: Uint8ClampedArray, y: number) => Array.from(m.subarray(y * W, y * W + W))
const coverage = (m: Uint8ClampedArray) => m.reduce((s, v) => s + v, 0) / 255

describe('edge slider transform (FR-19)', () => {
  it('50 is the identity and returns the base untouched', () => {
    const base = square()
    expect(applyEdge(base, W, H, 50)).toBe(base)
    expect(edgeRadii(50, 4000, 3000)).toEqual({ erode: 0, dilate: 0, feather: 0 })
  })

  it('strength scales with image size and grows with distance from 50', () => {
    expect(edgeMaxRadius(4000, 3000)).toBe(16)
    expect(edgeMaxRadius(100, 80)).toBe(2)
    expect(edgeRadii(0, 4000, 3000).erode).toBe(16)
    expect(edgeRadii(25, 4000, 3000).erode).toBe(8)
    expect(edgeRadii(49, 4000, 3000).erode).toBe(1)
    expect(edgeRadii(100, 4000, 3000)).toEqual({ erode: 0, dilate: 8, feather: 16 })
  })

  it('below 50 contracts the matte (removes a fringe) and keeps it hard-edged', () => {
    const base = square()
    const out = applyEdge(base, W, H, 0) // erode by 2 at this size
    expect(base[20 * W + 30]).toBe(255) // base untouched
    expect(out[20 * W + 30]).toBe(0)
    expect(out[21 * W + 31]).toBe(0)
    expect(out[22 * W + 32]).toBe(255)
    expect(coverage(out)).toBe(36 * 36)
    expect(new Set(out)).toEqual(new Set([0, 255]))
  })

  it('a soft fringe ring is removed by contraction', () => {
    const m = square()
    for (let x = 29; x <= 70; x++) m[19 * W + x] = m[60 * W + x] = 90 // 1-px semi-transparent halo
    for (let y = 19; y <= 60; y++) m[y * W + 29] = m[y * W + 70] = 90
    const out = applyEdge(m, W, H, 40)
    expect(row(out, 19).some((v) => v > 0)).toBe(false)
    expect(out[40 * W + 50]).toBe(255)
  })

  it('above 50 expands and feathers the matte', () => {
    const base = square()
    const out = applyEdge(base, W, H, 100)
    expect(coverage(out)).toBeGreaterThan(coverage(base))
    expect(out[40 * W + 28]).toBeGreaterThan(0) // grew outward
    expect(out[40 * W + 50]).toBe(255) // interior stays solid
    const ramp = row(out, 40).slice(24, 34)
    expect(ramp.filter((v) => v > 0 && v < 255).length).toBeGreaterThanOrEqual(2) // soft, not hard
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThanOrEqual(ramp[i - 1]) // monotone ramp
  })

  it('handles the full 0–100 range and edge-of-image subjects without error', () => {
    const full = new Uint8ClampedArray(W * H).fill(255)
    for (let v = 0; v <= 100; v += 10) {
      const out = applyEdge(full, W, H, v)
      expect(out.length).toBe(W * H)
      expect(out[0]).toBe(255) // image borders are clamped, not treated as transparent
    }
  })
})
