// LOCAL /matte/apply-edits (FR-17, FR-18, NFR-10). Brush strokes are applied to the full-resolution alpha mask in
// image pixels, so there is no preview-scale resampling of the edit itself. Everything is incremental: each stamp
// returns the dirty rectangle it touched, and only that region is re-composited and re-drawn.

import { BRUSH_RADIUS_MAX, BRUSH_RADIUS_MIN, clamp, type BrushMode, type BrushStroke, type EditState } from '../domain'
import { applyEdge } from './edge'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
type Point = { x: number; y: number }

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/**
 * Stamp one stroke segment (a capsule of radius `radius` around a→b; a single dab when a = b) into `mask`.
 * Erase moves alpha toward 0, restore toward 255. Coverage is anti-aliased over the outermost pixel only, so the
 * brush is hard-edged at any radius. Pixels outside the image are clipped; returns the touched rect or null.
 */
export function stampSegment(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  a: Point,
  b: Point,
  radius: number,
  mode: BrushMode,
): Rect | null {
  const r = clamp(radius, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX)
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r - 1))
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r - 1))
  const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + r + 1))
  const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + r + 1))
  if (x0 > x1 || y0 > y1 || !Number.isFinite(x0 + y0 + x1 + y1)) return null

  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const outer2 = (r + 0.5) * (r + 0.5)
  const inner2 = r > 0.5 ? (r - 0.5) * (r - 0.5) : 0
  const erase = mode === 'erase'

  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5 - a.y // pixel centre
    const row = y * width
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - a.x
      // Squared distance from the pixel centre to the segment.
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const ex = px - t * dx
      const ey = py - t * dy
      const d2 = ex * ex + ey * ey
      if (d2 >= outer2) continue
      const i = row + x
      if (d2 <= inner2) {
        mask[i] = erase ? 0 : 255
      } else {
        const cover = r + 0.5 - Math.sqrt(d2) // 0..1 across the edge pixel
        const v = mask[i]
        mask[i] = erase ? v * (1 - cover) : v + (255 - v) * cover
      }
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/** Stamp the segment that ends at `stroke.points[index]` (a dab for the first point). */
export function stampStrokePoint(mask: Uint8ClampedArray, width: number, height: number, stroke: BrushStroke, index: number): Rect | null {
  const b = stroke.points[index]
  const a = index > 0 ? stroke.points[index - 1] : b
  return stampSegment(mask, width, height, a, b, stroke.radius, stroke.mode)
}

/** Apply whole strokes in order. Returns the union of the touched rects. */
export function applyStrokes(mask: Uint8ClampedArray, width: number, height: number, strokes: readonly BrushStroke[]): Rect | null {
  let dirty: Rect | null = null
  for (const s of strokes) for (let i = 0; i < s.points.length; i++) dirty = unionRect(dirty, stampStrokePoint(mask, width, height, s, i))
  return dirty
}

/**
 * Write the edited alpha for `rect` into `pixels` (RGBA, full image size, holding the source colours).
 * The RGB channels are never touched, which is what lets restore bring back the original pixels (FR-18).
 * `sourceAlpha` is the source image's own transparency, or null when it is fully opaque.
 */
export function compositeRegion(pixels: Uint8ClampedArray, mask: Uint8ClampedArray, sourceAlpha: Uint8ClampedArray | null, width: number, rect: Rect) {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    let p = y * width + rect.x
    const end = p + rect.width
    if (sourceAlpha) for (; p < end; p++) pixels[p * 4 + 3] = (mask[p] * sourceAlpha[p] + 127) / 255
    else for (; p < end; p++) pixels[p * 4 + 3] = mask[p]
  }
}

/**
 * Full-resolution edit state for one cutout: the working mask (auto-removal matte + strokes) and the cutout RGBA.
 * `stamp` is the hot path for live painting; `sync` reconciles with the stored strokes (append, reset, undo).
 */
export class MaskEditor {
  readonly mask: Uint8ClampedArray
  /** Cutout RGBA: source colours with the edited alpha. */
  readonly pixels: Uint8ClampedArray<ArrayBuffer>
  readonly width: number
  readonly height: number
  private readonly sourceAlpha: Uint8ClampedArray | null
  private baseMask: Uint8ClampedArray
  private applied: readonly BrushStroke[] = []

  /** Takes ownership of `sourceRgba` (the decoded source, full size); `baseMask` is copied and never mutated. */
  constructor(width: number, height: number, sourceRgba: Uint8ClampedArray<ArrayBuffer>, baseMask: Uint8ClampedArray) {
    if (sourceRgba.length !== width * height * 4 || baseMask.length !== width * height) throw new RangeError('MaskEditor: size mismatch')
    this.width = width
    this.height = height
    this.baseMask = baseMask
    this.pixels = sourceRgba
    let opaque = true
    for (let i = 3; i < sourceRgba.length; i += 4) if (sourceRgba[i] !== 255) { opaque = false; break }
    this.sourceAlpha = opaque ? null : sourceRgba.filter((_, i) => i % 4 === 3)
    this.mask = new Uint8ClampedArray(baseMask)
    compositeRegion(this.pixels, this.mask, this.sourceAlpha, width, this.full())
  }

  full(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height }
  }

  /**
   * Swap the matte the strokes are painted over (the auto matte after the edge transform, FR-19) and replay the
   * strokes on top, so edge changes never alter brush work. Returns the full image rect to redraw.
   */
  setBase(base: Uint8ClampedArray): Rect {
    if (base.length !== this.width * this.height) throw new RangeError('MaskEditor: size mismatch')
    this.baseMask = base
    this.mask.set(base)
    applyStrokes(this.mask, this.width, this.height, this.applied)
    compositeRegion(this.pixels, this.mask, this.sourceAlpha, this.width, this.full())
    return this.full()
  }

  /** Recompute the mask from the current base and the committed strokes. */
  rebuild(): Rect {
    return this.setBase(this.baseMask)
  }

  /** Strokes currently reflected in the mask. */
  get strokes() {
    return this.applied
  }

  /** Live painting: stamp the segment ending at point `index` of an in-progress stroke. */
  stamp(stroke: BrushStroke, index: number): Rect | null {
    const dirty = stampStrokePoint(this.mask, this.width, this.height, stroke, index)
    if (dirty) compositeRegion(this.pixels, this.mask, this.sourceAlpha, this.width, dirty)
    return dirty
  }

  /** Record that `strokes` (ending with the stroke just painted live) is what the mask now shows. */
  commit(strokes: readonly BrushStroke[]) {
    this.applied = strokes
  }

  /**
   * Bring the mask in line with `strokes`. Appended strokes are stamped incrementally; any other change
   * (reset, undo) restarts from the auto-removal matte. Returns the region to redraw, or null.
   */
  sync(strokes: readonly BrushStroke[]): Rect | null {
    if (strokes === this.applied) return null
    const prev = this.applied
    const appended = strokes.length >= prev.length && prev.every((s, i) => strokes[i] === s)
    let dirty: Rect | null
    if (appended) {
      dirty = applyStrokes(this.mask, this.width, this.height, strokes.slice(prev.length))
    } else {
      this.mask.set(this.baseMask)
      applyStrokes(this.mask, this.width, this.height, strokes)
      dirty = this.full()
    }
    this.applied = strokes
    if (dirty) compositeRegion(this.pixels, this.mask, this.sourceAlpha, this.width, dirty)
    return dirty
  }
}

/**
 * The shared edit pipeline (LOCAL /matte/apply-edits): auto matte → edge transform → brush strokes, over the
 * source colours. Preview and export both go through this, so they cannot disagree. Crop is applied by the caller
 * when it reads the output region. Takes ownership of `sourceRgba` and returns it with the edited alpha.
 */
export function renderEdits(
  sourceRgba: Uint8ClampedArray<ArrayBuffer>,
  alphaMask: Uint8ClampedArray,
  width: number,
  height: number,
  edit: Pick<EditState, 'edgeValue' | 'strokes'>,
): Uint8ClampedArray<ArrayBuffer> {
  const editor = new MaskEditor(width, height, sourceRgba, applyEdge(alphaMask, width, height, edit.edgeValue))
  editor.sync(edit.strokes)
  return editor.pixels
}
