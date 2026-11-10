import { describe, expect, it } from 'vitest'
import { colorKeyMatte, detectFlatBackground, type RGB } from './colorKey'

/** W×H image painted by `paint(x, y)` → RGB; fully opaque. */
function image(w: number, h: number, paint: (x: number, y: number) => RGB) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      ;[rgba[i], rgba[i + 1], rgba[i + 2]] = paint(x, y)
      rgba[i + 3] = 255
    }
  return rgba
}
const grey = (v: number): RGB => [v, v, v]

/** Wavy horizontal lines, `thick` px wide every `period` px, with a one-pixel anti-aliased rim. */
function wavyLines(w: number, h: number, ink: number, paper: number, thick = 6, period = 40) {
  const kind = new Uint8Array(w * h) // 0 paper, 1 rim, 2 line
  const rgba = image(w, h, (x, y) => {
    const m = (((y + 8 * Math.sin(x / 15)) % period) + period) % period
    const k = m < thick ? 2 : m < thick + 1 ? 1 : 0
    kind[y * w + x] = k
    return grey(k === 2 ? ink : k === 1 ? (ink + paper) / 2 : paper)
  })
  return { rgba, kind }
}

/** Mean matte value per pixel kind. */
function meanBy(matte: Uint8ClampedArray, kind: Uint8Array, k: number) {
  let s = 0
  let n = 0
  for (let p = 0; p < matte.length; p++) if (kind[p] === k) (s += matte[p]), n++
  return s / n
}

describe('colour-key matting for flat graphics', () => {
  it('black lines on white: white gaps become fully transparent and the lines stay opaque', () => {
    const { rgba, kind } = wavyLines(240, 160, 0, 255)
    const key = detectFlatBackground(rgba, 240, 160)
    expect(key).toEqual({ background: [255, 255, 255], palette: [[0, 0, 0]] })
    const matte = colorKeyMatte(rgba, 240, 160, key!)
    expect(meanBy(matte, kind, 0)).toBe(0) // no haze between the lines
    expect(meanBy(matte, kind, 2)).toBe(255)
    const rim = meanBy(matte, kind, 1) // anti-aliasing keeps a partial alpha
    expect(rim).toBeGreaterThan(80)
    expect(rim).toBeLessThan(180)
  })

  it('white lines on black (inverted): the white lines are kept and the black removed', () => {
    const { rgba, kind } = wavyLines(240, 160, 255, 0)
    const key = detectFlatBackground(rgba, 240, 160)
    expect(key?.background).toEqual([0, 0, 0])
    const matte = colorKeyMatte(rgba, 240, 160, key!)
    expect(meanBy(matte, kind, 0)).toBe(0)
    expect(meanBy(matte, kind, 2)).toBe(255)
  })

  it('tolerates paper grain / JPEG noise on the background', () => {
    let seed = 7
    const noise = () => ((seed = (seed * 16807) % 2147483647) % 13) - 6
    const { rgba, kind } = wavyLines(240, 160, 10, 245)
    for (let p = 0; p < kind.length; p++) if (kind[p] === 0) for (let c = 0; c < 3; c++) rgba[p * 4 + c] += noise()
    const key = detectFlatBackground(rgba, 240, 160)
    expect(key).not.toBeNull()
    const matte = colorKeyMatte(rgba, 240, 160, key!)
    expect(meanBy(matte, kind, 0)).toBeLessThan(1)
    expect(meanBy(matte, kind, 2)).toBe(255)
  })

  it('a multi-colour logo keeps every ink colour opaque', () => {
    const rgba = image(200, 120, (x, y) => (x > 30 && x < 90 && y > 30 && y < 90 ? [220, 40, 40] : x > 110 && x < 170 && y > 30 && y < 90 ? [30, 60, 200] : grey(250)))
    const key = detectFlatBackground(rgba, 200, 120)
    expect(key?.palette).toHaveLength(2)
    const matte = colorKeyMatte(rgba, 200, 120, key!)
    expect(matte[60 * 200 + 60]).toBe(255)
    expect(matte[60 * 200 + 140]).toBe(255)
    expect(matte[5 * 200 + 5]).toBe(0)
  })

  it('photos, gradients and soft shapes are left to the AI model', () => {
    // Smooth vignette (studio backdrop).
    const vignette = image(200, 140, (x, y) => grey(255 - Math.hypot(x - 100, y - 70) * 0.6))
    expect(detectFlatBackground(vignette, 200, 140)).toBeNull()
    // Blurry blob on a flat background (bokeh): its colours are blends spread over many pixels.
    const blob = image(200, 140, (x, y) => grey(240 - 200 * Math.exp(-((x - 100) ** 2 + (y - 70) ** 2) / 900)))
    expect(detectFlatBackground(blob, 200, 140)).toBeNull()
    // Textured subject in many colours on a flat background.
    const subject = image(200, 140, (x, y) =>
      Math.hypot(x - 100, y - 70) < 50 ? [(x * 37) % 256, (y * 53) % 256, ((x + y) * 29) % 256] : [120, 170, 220],
    )
    expect(detectFlatBackground(subject, 200, 140)).toBeNull()
    // No single border colour.
    const halves = image(200, 140, (x) => (x < 100 ? grey(0) : grey(255)))
    expect(detectFlatBackground(halves, 200, 140)).toBeNull()
  })

  it('an image whose border is already transparent is not keyed', () => {
    const rgba = image(100, 100, () => grey(0))
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (Math.hypot(x - 50, y - 50) > 30) rgba[(y * 100 + x) * 4 + 3] = 0
    expect(detectFlatBackground(rgba, 100, 100)).toBeNull()
  })

  it('forced keying always returns a key, using the dominant border colour', () => {
    const vignette = image(120, 80, (x, y) => grey(255 - Math.hypot(x - 60, y - 40) * 0.8))
    const key = detectFlatBackground(vignette, 120, 80, true)
    expect(key).not.toBeNull()
    expect(colorKeyMatte(vignette, 120, 80, key!)).toHaveLength(120 * 80)
  })
})
