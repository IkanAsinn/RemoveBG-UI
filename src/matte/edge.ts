// FR-19 edge slider. 50 = the model's matte unchanged. Below 50 the matte is eroded (removes the halo/fringe
// of background colour around the subject); above 50 it is dilated and then feathered (softer, wider edge).
// Strength scales with image size so the slider feels the same on a 1 MP and a 12 MP photo.

import { clamp, EDGE_VALUE_DEFAULT, EDGE_VALUE_MAX, EDGE_VALUE_MIN } from '../domain'

/** Largest erosion/feather radius at the slider ends, in image pixels: 0.4% of the longest side, at least 2. */
export function edgeMaxRadius(width: number, height: number) {
  return Math.max(2, Math.round(Math.max(width, height) * 0.004))
}

/** Radii for an edge value: erode (contract), dilate + feather (expand). All zero at the default. */
export function edgeRadii(edgeValue: number, width: number, height: number) {
  const d = (clamp(edgeValue, EDGE_VALUE_MIN, EDGE_VALUE_MAX) - EDGE_VALUE_DEFAULT) / (EDGE_VALUE_MAX - EDGE_VALUE_DEFAULT)
  const R = edgeMaxRadius(width, height)
  if (d < 0) return { erode: Math.max(1, Math.round(-d * R)), dilate: 0, feather: 0 }
  if (d > 0) return { erode: 0, dilate: Math.round((d * R) / 2), feather: Math.max(1, Math.round(d * R)) }
  return { erode: 0, dilate: 0, feather: 0 }
}

// All passes run along rows (cache-friendly); vertical passes transpose, filter rows, and transpose back.

/** Blocked transpose of a w×h image into dst (h×w). */
function transpose(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const B = 64
  for (let y0 = 0; y0 < h; y0 += B) {
    const y1 = Math.min(h, y0 + B)
    for (let x0 = 0; x0 < w; x0 += B) {
      const x1 = Math.min(w, x0 + B)
      for (let y = y0; y < y1; y++) {
        let i = y * w + x0
        for (let x = x0; x < x1; x++, i++) dst[x * h + y] = src[i]
      }
    }
  }
}

/**
 * Running min/max over a window of 2r+1 along each row (van Herk / Gil-Werman: O(1) per pixel for any r).
 * Samples beyond the row ends are ignored, i.e. the image border neither erodes nor dilates the matte.
 */
function morphRows(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, isMax: boolean) {
  const k = 2 * r + 1
  const len = w + 2 * r
  const g = new Uint8Array(len)
  const hh = new Uint8Array(len)
  const pad = isMax ? 0 : 255
  for (let y = 0, row = 0; y < h; y++, row += w) {
    // Forward and backward block-wise cumulative extremes over the padded row.
    for (let s = 0; s < len; s += k) {
      const e = Math.min(len, s + k)
      let acc = pad
      for (let i = s; i < e; i++) {
        const j = i - r
        const v = j >= 0 && j < w ? src[row + j] : pad
        acc = isMax ? (v > acc ? v : acc) : v < acc ? v : acc
        g[i] = acc
      }
      acc = pad
      for (let i = e - 1; i >= s; i--) {
        const j = i - r
        const v = j >= 0 && j < w ? src[row + j] : pad
        acc = isMax ? (v > acc ? v : acc) : v < acc ? v : acc
        hh[i] = acc
      }
    }
    // Window [j, j + 2r] in padded coordinates = hh[j] combined with g[j + 2r].
    if (isMax) for (let j = 0; j < w; j++) { const p = hh[j], q = g[j + 2 * r]; dst[row + j] = p > q ? p : q }
    else for (let j = 0; j < w; j++) { const p = hh[j], q = g[j + 2 * r]; dst[row + j] = p < q ? p : q }
  }
}

/** Box blur of radius r along each row (running sum, edge-clamped). */
function boxRows(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const k = 2 * r + 1
  const half = k >> 1
  const last = w - 1
  for (let y = 0, row = 0; y < h; y++, row += w) {
    const first = src[row]
    const end = src[row + last]
    let sum = first * (r + 1)
    for (let j = 1; j <= r; j++) sum += src[row + (j < w ? j : last)]
    for (let j = 0; j < w; j++) {
      dst[row + j] = ((sum + half) / k) | 0
      const add = j + r + 1
      const sub = j - r
      sum += (add < w ? src[row + add] : end) - (sub > 0 ? src[row + sub] : first)
    }
  }
}

/** 2-D separable min/max (square window 2r+1). Result in `out`; `tmp` is scratch. */
function morph(mask: Uint8Array, w: number, h: number, r: number, isMax: boolean, tmp: Uint8Array, out: Uint8Array) {
  morphRows(mask, out, w, h, r, isMax)
  transpose(out, tmp, w, h)
  morphRows(tmp, out, h, w, r, isMax)
  transpose(out, tmp, h, w)
  out.set(tmp)
}

/** Two box passes per axis ≈ a smooth (triangular) feather of radius ~r. Result in `out`. */
function blur(mask: Uint8Array, w: number, h: number, r: number, tmp: Uint8Array, out: Uint8Array) {
  const half = Math.max(1, Math.round(r / 2))
  boxRows(mask, tmp, w, h, half)
  boxRows(tmp, out, w, h, half)
  transpose(out, tmp, w, h)
  boxRows(tmp, out, h, w, half)
  boxRows(out, tmp, h, w, half)
  transpose(tmp, out, h, w)
}

/**
 * Apply the edge slider to a full-resolution matte. Returns `base` itself at the default value, otherwise a new
 * array; `base` is never modified. The same function feeds the preview and the export (shared pipeline).
 */
export function applyEdge(base: Uint8ClampedArray, width: number, height: number, edgeValue: number): Uint8ClampedArray {
  const { erode, dilate, feather } = edgeRadii(edgeValue, width, height)
  if (!erode && !dilate && !feather) return base
  const src = new Uint8Array(base.buffer, base.byteOffset, base.length)
  const tmp = new Uint8Array(base.length)
  const out = new Uint8Array(base.length)
  if (erode) {
    morph(src, width, height, erode, false, tmp, out)
  } else {
    // Dilate by r/2, then feather over r: the 50% contour moves outward and the edge ramp widens.
    let grown = src
    if (dilate) {
      grown = new Uint8Array(base.length)
      morph(src, width, height, dilate, true, tmp, grown)
    }
    blur(grown, width, height, feather, tmp, out)
  }
  return new Uint8ClampedArray(out.buffer)
}
