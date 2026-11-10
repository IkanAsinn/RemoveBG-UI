// LOCAL /composite/background (FR-24…FR-29). One drawing routine for the background layer, used at preview scale
// by the editor and at full output resolution by export, so the two cannot drift apart.

import type { BackgroundSelection } from '../domain'
import { bundledGradient } from './gradients'
import { bundledTemplate } from './templates'
import { ingestImage } from '../image/ingest'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Normalise user hex input ("#ABC", "a1b2c3", " #A1B2C3 ") to "#a1b2c3"; null when it is not a colour. */
export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return `#${h.toLowerCase()}`
}

/** True when this selection paints anything (Transparent, or a mode with nothing chosen yet, paints nothing). */
export function hasBackgroundLayer(bg: BackgroundSelection): boolean {
  switch (bg.type) {
    case 'transparent':
      return false
    case 'solid':
      return !!bg.color && normalizeHex(bg.color) !== null
    case 'image':
      return !!bg.imageBitmap
    case 'gradient':
      return !!bg.gradientId
    case 'template':
      return !!bg.templateId
  }
}

/** Rectangle that covers width × height with the source's aspect ratio (CSS object-fit: cover), centred. */
export function coverRect(srcW: number, srcH: number, width: number, height: number) {
  const k = Math.max(width / srcW, height / srcH)
  const w = srcW * k
  const h = srcH * k
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }
}

export interface BackgroundAssets {
  /** Resolves a gradient id to a fill for the output size. Defaults to the bundled GradientAssets (FR-27). */
  gradient?: (ctx: Ctx2D, id: string, width: number, height: number) => CanvasGradient | null
  /** Resolves a template id to a decoded image. Defaults to the bundled templates loaded in this tab (FR-28). */
  template?: (id: string) => CanvasImageSource | null
}

/**
 * Paint the background layer for an output of `width` × `height`. Only the selected type is drawn, so switching
 * modes never leaves the previous background visible; Transparent draws nothing (alpha is preserved).
 */
export function drawBackground(ctx: Ctx2D, bg: BackgroundSelection, width: number, height: number, assets: BackgroundAssets = {}) {
  ctx.clearRect(0, 0, width, height)
  if (!hasBackgroundLayer(bg)) return
  switch (bg.type) {
    case 'solid':
      ctx.fillStyle = normalizeHex(bg.color!)!
      ctx.fillRect(0, 0, width, height)
      return
    case 'image': {
      const img = bg.imageBitmap!
      const r = coverRect(img.width, img.height, width, height)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, r.x, r.y, r.width, r.height)
      return
    }
    case 'gradient': {
      const fill = (assets.gradient ?? bundledGradient)(ctx, bg.gradientId!, width, height)
      if (!fill) return
      ctx.fillStyle = fill
      ctx.fillRect(0, 0, width, height)
      return
    }
    case 'template': {
      const img = (assets.template ?? bundledTemplate)(bg.templateId!)
      if (!img) return
      const { width: iw, height: ih } = img as { width: number; height: number }
      const r = coverRect(iw, ih, width, height)
      ctx.drawImage(img, r.x, r.y, r.width, r.height)
      return
    }
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

/**
 * The background layer for an output region of `width` × `height`, or null when the selection paints nothing
 * (Transparent). Preview builds it at preview size, export at full output size, from the same drawBackground.
 */
export function backgroundLayer(
  bg: BackgroundSelection,
  width: number,
  height: number,
  makeCanvas: (w: number, h: number) => { canvas: AnyCanvas; ctx: Ctx2D },
  assets?: BackgroundAssets,
): AnyCanvas | null {
  if (!hasBackgroundLayer(bg)) return null
  const { canvas, ctx } = makeCanvas(width, height)
  drawBackground(ctx, bg, width, height, assets)
  return canvas
}

/**
 * FR-29: the one compositing step shared by preview and export. Copies `src` (image pixels of the edited cutout) to
 * `dst` (pixels of the target canvas) with the background layer behind it. `layer` is in the target's pixel space
 * and covers the whole output region; Transparent passes null, so the result keeps the cutout's alpha.
 */
export function compositeCutout(ctx: Ctx2D, cutout: CanvasImageSource, src: Rect, dst: Rect, layer: CanvasImageSource | null) {
  ctx.clearRect(dst.x, dst.y, dst.width, dst.height)
  if (layer) ctx.drawImage(layer, dst.x, dst.y, dst.width, dst.height, dst.x, dst.y, dst.width, dst.height)
  ctx.drawImage(cutout, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height)
}

/**
 * FR-26: decode a background upload with the same decoders as the main image (native, then bundled HEIC/HEIF WASM),
 * EXIF orientation applied. Throws when the file cannot be decoded.
 */
export async function decodeBackgroundImage(file: File): Promise<{ blob: Blob; bitmap: ImageBitmap }> {
  const image = await ingestImage(file, file.name, 'upload')
  return { blob: file, bitmap: image.decodedBitmap }
}
