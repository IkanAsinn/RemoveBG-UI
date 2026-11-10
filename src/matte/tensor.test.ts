// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { matteToAlphaRgba, rgbaToInputTensor } from './tensor'

describe('rgbaToInputTensor', () => {
  it('produces planar NCHW data normalised by image max, mean and std', () => {
    // 2×2 image: red, green, blue, white (alpha ignored)
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 9, 255, 255, 255, 255])
    const t = rgbaToInputTensor(rgba, 2, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5])
    expect(t).toHaveLength(12)
    expect(Array.from(t.subarray(0, 4))).toEqual([1, -1, -1, 1]) // R plane
    expect(Array.from(t.subarray(4, 8))).toEqual([-1, 1, -1, 1]) // G plane
    expect(Array.from(t.subarray(8, 12))).toEqual([-1, -1, 1, 1]) // B plane
  })

  it('divides by the image max channel value like rembg (a dim image is stretched)', () => {
    const rgba = new Uint8ClampedArray([100, 50, 0, 255])
    const t = rgbaToInputTensor(rgba, 1, [0, 0, 0], [1, 1, 1])
    expect(Array.from(t)).toEqual([1, 0.5, 0])
  })
})

describe('matteToAlphaRgba', () => {
  it('min-max normalises model output into the alpha channel', () => {
    const rgba = matteToAlphaRgba(new Float32Array([0.2, 0.6, 1.0, 0.2]), 2)
    expect(Array.from(rgba.filter((_, i) => i % 4 === 3))).toEqual([0, 128, 255, 0])
    expect(rgba[0]).toBe(255) // colour channels are irrelevant but opaque-white
  })

  it('a flat output does not divide by zero', () => {
    const rgba = matteToAlphaRgba(new Float32Array([0.5, 0.5, 0.5, 0.5]), 2)
    expect(rgba.every((v) => Number.isFinite(v))).toBe(true)
  })
})
