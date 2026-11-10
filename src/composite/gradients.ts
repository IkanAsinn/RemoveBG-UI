// FR-27 bundled gradients. Each GradientAsset stores a CSS `linear-gradient(...)` value: the panel shows it directly as a
// CSS background, and `createCssGradient` turns the same string into a canvas gradient with CSS geometry, so the
// thumbnail, the preview and the export all come from one definition.

import type { GradientAsset } from '../domain'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export const GRADIENTS: readonly GradientAsset[] = [
  { id: 'sunset', name: 'Sunset', cssValue: 'linear-gradient(135deg, #ff9a8b 0%, #ff6a88 55%, #ff99ac 100%)' },
  { id: 'ocean', name: 'Ocean', cssValue: 'linear-gradient(180deg, #2e8bc0 0%, #0c2d48 100%)' },
  { id: 'mint', name: 'Mint', cssValue: 'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)' },
  { id: 'peach', name: 'Peach', cssValue: 'linear-gradient(90deg, #ffecd2 0%, #fcb69f 100%)' },
  { id: 'lavender', name: 'Lavender', cssValue: 'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)' },
  { id: 'studio', name: 'Studio grey', cssValue: 'linear-gradient(180deg, #f5f5f5 0%, #c9ccd1 100%)' },
  { id: 'night', name: 'Night', cssValue: 'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'citrus', name: 'Citrus', cssValue: 'linear-gradient(45deg, #f6d365 0%, #fda085 100%)' },
]

export const gradientById = (id: string | null | undefined): GradientAsset | undefined => GRADIENTS.find((g) => g.id === id)

export interface ParsedGradient {
  /** CSS angle in degrees: 0 points up, 90 right, clockwise. */
  angle: number
  stops: Array<{ color: string; offset: number }>
}

const SIDES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 }

/** Split on commas that are not inside parentheses (so rgb(1, 2, 3) stays whole). */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(s.slice(start).trim())
  return out
}

/**
 * Parse `linear-gradient(<angle>deg | to <side>, <color> [<pct>%], ...)`. Missing stop positions are spread evenly
 * between their neighbours, as CSS does. Returns null for anything else.
 */
export function parseLinearGradient(css: string): ParsedGradient | null {
  const m = /^\s*linear-gradient\((.*)\)\s*$/i.exec(css)
  if (!m) return null
  const parts = splitTopLevel(m[1])
  let angle = 180 // CSS default: to bottom
  const head = parts[0].toLowerCase()
  const deg = /^(-?\d+(?:\.\d+)?)deg$/.exec(head)
  const side = /^to (top|right|bottom|left)$/.exec(head)
  if (deg) angle = Number(deg[1])
  if (side) angle = SIDES[side[1]]
  const stopParts = deg || side ? parts.slice(1) : parts
  if (stopParts.length < 2) return null

  const raw = stopParts.map((p) => {
    const s = /^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/.exec(p)!
    return { color: s[1].trim(), offset: s[2] === undefined ? null : Number(s[2]) / 100 }
  })
  if (raw.some((r) => !r.color)) return null
  if (raw[0].offset === null) raw[0].offset = 0
  if (raw[raw.length - 1].offset === null) raw[raw.length - 1].offset = 1
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].offset !== null) continue
    let j = i
    while (raw[j].offset === null) j++
    const a = raw[i - 1].offset!
    const b = raw[j].offset!
    for (let k = i; k < j; k++) raw[k].offset = a + ((b - a) * (k - i + 1)) / (j - i + 1)
  }
  // CSS clamps each stop to be no earlier than the previous one; canvas offsets must also lie in 0..1.
  let prev = 0
  const stops = raw.map((r) => {
    prev = Math.max(prev, Math.min(1, Math.max(0, r.offset!)))
    return { color: r.color, offset: prev }
  })
  return { angle, stops }
}

/**
 * Canvas gradient matching CSS `linear-gradient` over a width × height box: the gradient line passes through the
 * centre at `angle`, and its length is |W·sin a| + |H·cos a| so the 0% and 100% stops touch opposite corners.
 */
export function createCssGradient(ctx: Ctx2D, css: string, width: number, height: number): CanvasGradient | null {
  const g = parseLinearGradient(css)
  if (!g) return null
  const a = (g.angle * Math.PI) / 180
  // Snap floating-point noise so axis-aligned gradients are exact (sin(π) is 1.2e-16, not 0).
  const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v)
  const dx = snap(Math.sin(a))
  const dy = snap(-Math.cos(a))
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2
  const cx = width / 2
  const cy = height / 2
  const grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  try {
    for (const s of g.stops) grad.addColorStop(s.offset, s.color)
  } catch {
    return null // invalid colour
  }
  return grad
}

/** Resolver used by drawBackground for preview and export. */
export function bundledGradient(ctx: Ctx2D, id: string, width: number, height: number): CanvasGradient | null {
  const asset = gradientById(id)
  return asset ? createCssGradient(ctx, asset.cssValue, width, height) : null
}
