// Full-resolution output rendering: the edited cutout (source RGB + edited matte, via the shared renderEdits pipeline)
// composited over the selected background at the source's full resolution minus crop (NFR-7). The compositing step
// (backgroundLayer + compositeCutout) is the one the editor preview runs, so the export matches what is on screen
// (FR-29). Everything happens on local canvases; no image bytes leave the browser (NFR-1).

import { EDGE_VALUE_DEFAULT, type BackgroundSelection, type CropRect, type EditState } from '../domain'
import { renderEdits } from '../matte/applyEdits'
import { canvas2d } from '../matte/remove'
import { backgroundLayer, compositeCutout, type Rect } from './background'

export class EncodeError extends Error {
  constructor(message = 'Could not encode the output') {
    super(message)
    this.name = 'EncodeError'
  }
}

export interface OutputInput {
  /** Decoded source at full resolution. */
  source: CanvasImageSource
  width: number
  height: number
  /** Model matte, one byte per pixel at full resolution. */
  alphaMask: Uint8ClampedArray
  edit?: Pick<EditState, 'edgeValue' | 'strokes' | 'crop'> | null
  background: BackgroundSelection
}

/** Composite the output at full resolution onto a canvas. Transparent keeps alpha; other modes draw behind. */
export function renderOutput({ source, width: W, height: H, alphaMask, edit, background }: OutputInput) {
  const { canvas, ctx } = canvas2d(W, H, { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, W, H)
  const rgba = ctx.getImageData(0, 0, W, H).data
  const pixels = renderEdits(rgba, alphaMask, W, H, edit ?? { edgeValue: EDGE_VALUE_DEFAULT, strokes: [] })
  ctx.putImageData(new ImageData(pixels, W, H), 0, 0)
  // Output bounds: the crop when applied, else the full image, at 1:1 (never downscaled). The background covers
  // exactly these bounds and is composited by the same step the preview uses.
  const bounds = outputBounds(W, H, edit?.crop ?? null)
  const layer = backgroundLayer(background, bounds.width, bounds.height, canvas2d)
  // Transparent and uncropped: the edited cutout already is the output.
  if (!layer && bounds.width === W && bounds.height === H) return canvas
  const { canvas: out, ctx: outCtx } = canvas2d(bounds.width, bounds.height)
  compositeCutout(outCtx, canvas, bounds, { x: 0, y: 0, width: bounds.width, height: bounds.height }, layer)
  return out
}

/** Output region in source pixels: the applied crop (clamped to the image), else the whole image (NFR-7). */
export function outputBounds(width: number, height: number, crop: CropRect | null): Rect {
  if (!crop) return { x: 0, y: 0, width, height }
  const x = Math.max(0, Math.min(width - 1, Math.round(crop.x)))
  const y = Math.max(0, Math.min(height - 1, Math.round(crop.y)))
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(crop.width))),
    height: Math.max(1, Math.min(height - y, Math.round(crop.height))),
  }
}

/** Encode a canvas. Throws EncodeError instead of silently falling back to another format. */
export async function encodeCanvas(canvas: OffscreenCanvas | HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  let blob: Blob | null = null
  try {
    blob =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type, quality })
        : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  } catch {
    blob = null
  }
  if (!blob || blob.size === 0 || blob.type !== type) throw new EncodeError()
  return blob
}
