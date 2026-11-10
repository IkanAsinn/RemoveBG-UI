// Colour-key matting for flat graphics (logos, line art, text, scans of drawings).
//
// The AI models are salient-object segmenters: they look for "the subject" and are unreliable when there is none,
// e.g. a page of wavy black lines on white. There they can leave the gaps half transparent, or drop white lines on a
// black page entirely. For images that are a uniform background plus a few flat colours, a colour key is exact:
// every pixel's alpha is how far it sits from the background colour, toward the ink colour it is made of, so
// anti-aliased edges keep their partial transparency.
//
// Pure functions over RGBA pixels (no DOM), shared by the single-image flow and the batch.

export type RGB = [number, number, number]

export interface FlatBackground {
  /** The background colour removed by the key. */
  background: RGB
  /** Dominant non-background ("ink") colours, strongest first; anti-aliased pixels are blends with the background. */
  palette: RGB[]
}

/** Pixels this close to the background colour count as background (absorbs JPEG noise and paper grain). */
const BG_NEAR = 48
/** Nearly all background pixels of a flat graphic are this close to its colour. */
const BG_TIGHT = 20
/** Alpha is 0 up to this distance from the background colour. */
const KEY_FLOOR = 14
/** A pixel this close to a background→ink (or ink→ink) blend line is "explained" by the palette. */
const ON_BLEND = 30
/** Upper bound of pixels inspected for detection (the image is sampled on a grid). */
const MAX_SAMPLES = 300_000
const MAX_PALETTE = 8
/** A pixel this close to an ink colour is solid ink. */
const SOLID = 24
/** How far (in pixels) an anti-aliased pixel may be from solid background or ink. */
const EDGE_REACH = 3

const dist2 = (r: number, g: number, b: number, c: RGB) => (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2
const binOf = (r: number, g: number, b: number) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)

/** Squared distance from p to the segment a→b in RGB space. */
function segDist2(r: number, g: number, b: number, a: RGB, c: RGB) {
  const dx = c[0] - a[0]
  const dy = c[1] - a[1]
  const dz = c[2] - a[2]
  const px = r - a[0]
  const py = g - a[1]
  const pz = b - a[2]
  const len2 = dx * dx + dy * dy + dz * dz
  let t = len2 > 0 ? (px * dx + py * dy + pz * dz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return (px - t * dx) ** 2 + (py - t * dy) ** 2 + (pz - t * dz) ** 2
}

/** Most common colour around the image border, and the share of border pixels close to it. */
function borderColour(rgba: Uint8ClampedArray, w: number, h: number) {
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.01))
  const step = Math.max(1, Math.floor((2 * (w + h) * ring) / 20_000))
  const pts: number[] = []
  let transparent = 0
  let n = 0
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4
    n++
    if (rgba[i + 3] < 16) transparent++
    else pts.push(i)
  }
  for (let k = 0; k < ring; k++) {
    for (let x = 0; x < w; x += step) {
      take(x, k)
      take(x, h - 1 - k)
    }
    for (let y = ring; y < h - ring; y += step) {
      take(k, y)
      take(w - 1 - k, y)
    }
  }
  if (pts.length === 0) return { colour: null, share: 0, transparentShare: n ? transparent / n : 0 }
  const counts = new Map<number, number>()
  let best = -1
  let bestCount = 0
  for (const i of pts) {
    const key = binOf(rgba[i], rgba[i + 1], rgba[i + 2])
    const c = (counts.get(key) ?? 0) + 1
    counts.set(key, c)
    if (c > bestCount) {
      bestCount = c
      best = key
    }
  }
  const sum = [0, 0, 0]
  let m = 0
  for (const i of pts) {
    if (binOf(rgba[i], rgba[i + 1], rgba[i + 2]) !== best) continue
    sum[0] += rgba[i]
    sum[1] += rgba[i + 1]
    sum[2] += rgba[i + 2]
    m++
  }
  const colour: RGB = [Math.round(sum[0] / m), Math.round(sum[1] / m), Math.round(sum[2] / m)]
  let near = 0
  for (const i of pts) if (dist2(rgba[i], rgba[i + 1], rgba[i + 2], colour) <= BG_NEAR * BG_NEAR) near++
  return { colour, share: near / n, transparentShare: transparent / n }
}

/**
 * Decide whether `rgba` is a flat graphic: a uniform background colour (dominating the border) with a small palette
 * of ink colours whose blends explain nearly every other pixel. Photos, gradients and textured backgrounds return
 * null, so they stay on the AI model. With `force`, always returns a best-effort key (the user asked for it).
 */
export function detectFlatBackground(rgba: Uint8ClampedArray, width: number, height: number, force = false): FlatBackground | null {
  const border = borderColour(rgba, width, height)
  if (!border.colour) return null // border fully transparent: the image is already cut out
  const bg = border.colour
  if (!force && border.share < 0.55) return null

  const total = width * height
  const stride = Math.max(1, Math.floor(Math.sqrt(total / MAX_SAMPLES)))
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  const fg: number[] = []
  let samples = 0
  let bgCount = 0
  let bgTight = 0
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4
      if (rgba[i + 3] < 16) continue
      samples++
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      const d2 = dist2(r, g, b, bg)
      if (d2 <= BG_NEAR * BG_NEAR) {
        bgCount++
        if (d2 <= BG_TIGHT * BG_TIGHT) bgTight++
        continue
      }
      fg.push(i)
      const key = binOf(r, g, b)
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
      bin.n++
      bin.r += r
      bin.g += g
      bin.b += b
      bins.set(key, bin)
    }
  }
  if (fg.length === 0) return force ? { background: bg, palette: [] } : null
  // The background must be one flat colour (not a vignette or studio sweep) and cover a real share of the image.
  if (!force && (bgCount < samples * 0.1 || bgTight < bgCount * 0.9 || fg.length < samples * 0.001)) return null

  // Palette: the heaviest colour bins, merging bins that are really one colour split across a bin boundary.
  const palette: Array<{ c: RGB; n: number }> = []
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    if (bin.n < fg.length * 0.01 && palette.length > 0) break
    const c: RGB = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n]
    const same = palette.find((p) => dist2(c[0], c[1], c[2], p.c) <= 32 * 32)
    if (same) {
      const n = same.n + bin.n
      same.c = [(same.c[0] * same.n + c[0] * bin.n) / n, (same.c[1] * same.n + c[1] * bin.n) / n, (same.c[2] * same.n + c[2] * bin.n) / n]
      same.n = n
    } else if (palette.length < MAX_PALETTE) {
      palette.push({ c, n: bin.n })
    }
  }
  // A light ink with modest mass that lies on the blend from the background to a stronger ink is anti-aliasing
  // (e.g. the greys around black lines), not an ink of its own.
  const byStrength = palette.map((p) => ({ c: p.c.map(Math.round) as RGB, n: p.n, d: dist2(p.c[0], p.c[1], p.c[2], bg) })).sort((a, b) => b.d - a.d)
  const inks: RGB[] = []
  for (const ink of byStrength) {
    const blend = ink.n < fg.length * 0.25 && inks.some((c) => segDist2(ink.c[0], ink.c[1], ink.c[2], bg, c) <= ON_BLEND * ON_BLEND)
    if (!blend) inks.push(ink.c)
  }

  if (!force) {
    // 1. Every non-background pixel must be an ink colour or an anti-aliased blend (background↔ink or ink↔ink).
    const lines: Array<[RGB, RGB]> = inks.map((c) => [bg, c])
    for (let a = 0; a < inks.length; a++) for (let b = a + 1; b < inks.length; b++) lines.push([inks[a], inks[b]])
    let explained = 0
    for (const i of fg) {
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      for (const [p, q] of lines) {
        if (segDist2(r, g, b, p, q) <= ON_BLEND * ON_BLEND) {
          explained++
          break
        }
      }
    }
    if (explained < fg.length * 0.95) return null

    // 2. Edges must be sharp: a blend pixel sits within a few pixels of solid background or solid ink. Smooth
    // gradients, vignettes and bokeh are blends too, but their in-between colours stretch over many pixels.
    const solid = (i: number) => {
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      if (dist2(r, g, b, bg) <= BG_NEAR * BG_NEAR) return true
      for (const c of inks) if (dist2(r, g, b, c) <= SOLID * SOLID) return true
      return false
    }
    let soft = 0
    let blends = 0
    for (const i of fg) {
      if (solid(i)) continue
      blends++
      const p = i >> 2
      const x = p % width
      const y = (p - x) / width
      let near = false
      for (let dy = -EDGE_REACH; dy <= EDGE_REACH && !near; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -EDGE_REACH; dx <= EDGE_REACH; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < width && solid((yy * width + xx) * 4)) {
            near = true
            break
          }
        }
      }
      if (!near) soft++
    }
    if (blends > 0 && soft > blends * 0.1) return null
  }
  return { background: bg, palette: inks }
}

/**
 * Full-resolution alpha matte (one byte per pixel) for a flat graphic. Pixels on a background→ink blend get the blend
 * fraction as alpha (exact for anti-aliasing); colours not explained by the palette are treated as ink.
 */
export function colorKeyMatte(rgba: Uint8ClampedArray, width: number, height: number, key: FlatBackground): Uint8ClampedArray {
  const [br, bgG, bb] = key.background
  const inks = key.palette.map((c) => {
    const d: RGB = [c[0] - br, c[1] - bgG, c[2] - bb]
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    const len = Math.sqrt(len2)
    // Blend fraction where alpha starts (just above the noise floor) and where it is fully opaque.
    return { d, len2, t0: Math.min(0.5, KEY_FLOOR / (len || 1)), t1: 0.9 }
  })
  const out = new Uint8ClampedArray(width * height)
  const floor2 = KEY_FLOOR * KEY_FLOOR
  const goodFit2 = (ON_BLEND / 2) ** 2
  const onBlend2 = ON_BLEND * ON_BLEND
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const pr = rgba[i] - br
    const pg = rgba[i + 1] - bgG
    const pb = rgba[i + 2] - bb
    const d2 = pr * pr + pg * pg + pb * pb
    if (d2 <= floor2) continue // background: 0
    // Inks are ordered strongest (farthest from the background) first; the first close fit wins, so a mid-tone on
    // the line to a strong ink reads as a partially transparent edge of that ink.
    let bestRes = Infinity
    let alpha = 1
    for (const ink of inks) {
      if (ink.len2 === 0) continue
      let t = (pr * ink.d[0] + pg * ink.d[1] + pb * ink.d[2]) / ink.len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const res = (pr - t * ink.d[0]) ** 2 + (pg - t * ink.d[1]) ** 2 + (pb - t * ink.d[2]) ** 2
      if (res < bestRes) {
        bestRes = res
        alpha = t <= ink.t0 ? 0 : t >= ink.t1 ? 1 : (t - ink.t0) / (ink.t1 - ink.t0)
        if (res <= goodFit2) break
      }
    }
    if (bestRes > onBlend2) {
      // Not a blend with the background: an ink↔ink edge or an unlisted colour. Opaque once clearly off-background.
      const d = Math.sqrt(d2)
      alpha = d >= BG_NEAR ? 1 : (d - KEY_FLOOR) / (BG_NEAR - KEY_FLOOR)
    }
    out[p] = Math.round(alpha * 255)
  }
  return out
}
