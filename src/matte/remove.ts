// LOCAL /matte/remove (FR-10, FR-15, FR-16, NFR-1). Runs entirely in the browser: the only inputs are the
// in-memory SourceImage and an already-loaded model session. Nothing here performs a network request.

import { createCutoutResult, type CutoutResult, type MatteMode, type SourceImage } from '../domain'
import type { ModelHandle } from '../model/loader'
import { colorKeyMatte, detectFlatBackground } from './colorKey'
import { matteToAlphaRgba, rgbaToInputTensor } from './tensor'

export class CanvasTooLargeError extends Error {
  constructor() {
    super('Image is too large for this device to edit')
    this.name = 'CanvasTooLargeError'
  }
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** 2D canvas of an exact size. Browsers return null (or throw) when the area exceeds their limit. */
export function canvas2d(width: number, height: number, opts?: CanvasRenderingContext2DSettings): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
  let canvas: OffscreenCanvas | HTMLCanvasElement
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height)
  } else {
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
  }
  let ctx: Canvas2D | null = null
  try {
    ctx = canvas.getContext('2d', opts) as Canvas2D | null
  } catch {
    // fall through
  }
  if (!ctx) throw new CanvasTooLargeError()
  return { canvas, ctx }
}

/** Run the model on a square resize of the source and return its matte as an S×S canvas (alpha = matte). */
async function runMatte(handle: ModelHandle, source: SourceImage) {
  const { inputSize: S, mean, std } = handle.info
  const { ctx: inCtx } = canvas2d(S, S, { willReadFrequently: true })
  inCtx.imageSmoothingQuality = 'high'
  inCtx.drawImage(source.decodedBitmap, 0, 0, S, S)
  const input = rgbaToInputTensor(inCtx.getImageData(0, 0, S, S).data, S, mean, std)

  const output = await handle.session.run(input, [1, 3, S, S]) // runs in the model's worker
  const matte = matteToAlphaRgba(output, S)
  const { canvas, ctx } = canvas2d(S, S)
  ctx.putImageData(new ImageData(matte as Uint8ClampedArray<ArrayBuffer>, S, S), 0, 0)
  return canvas
}

/** Cutout = source pixels kept where the mask is opaque. `mask` is a canvas whose alpha is the matte. */
async function cutoutFromMask(source: CanvasImageSource, mask: CanvasImageSource, W: number, H: number): Promise<ImageBitmap> {
  const { canvas: cut, ctx: cutCtx } = canvas2d(W, H)
  cutCtx.drawImage(source, 0, 0)
  cutCtx.globalCompositeOperation = 'destination-in'
  cutCtx.drawImage(mask, 0, 0)
  return createImageBitmap(cut)
}

/** Rebuild a cutout bitmap from a stored one-byte-per-pixel alpha mask (e.g. a batch item reopened for editing). */
export async function cutoutBitmapFromAlpha(source: CanvasImageSource, alphaMask: Uint8ClampedArray, W: number, H: number): Promise<ImageBitmap> {
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let p = 0, i = 3; p < alphaMask.length; p++, i += 4) rgba[i] = alphaMask[p]
  const { canvas: mask, ctx } = canvas2d(W, H)
  ctx.putImageData(new ImageData(rgba, W, H), 0, 0)
  return cutoutFromMask(source, mask, W, H)
}

/**
 * Colour-key cutout for flat graphics (line art, logos, text). Returns null when `mode` is 'auto' and the image does
 * not look like a flat graphic, so the caller falls back to the model.
 */
async function colorKeyCutout(handle: ModelHandle, source: SourceImage, mode: MatteMode): Promise<CutoutResult | null> {
  const { width: W, height: H } = source
  const { ctx } = canvas2d(W, H, { willReadFrequently: true })
  ctx.drawImage(source.decodedBitmap, 0, 0)
  const rgba = ctx.getImageData(0, 0, W, H).data
  const key = detectFlatBackground(rgba, W, H, mode === 'color')
  if (!key) return null
  const alphaMask = colorKeyMatte(rgba, W, H, key)
  return createCutoutResult({
    sourceImageId: source.id,
    modelTier: handle.tier,
    matteSource: 'color',
    cutoutBitmap: await cutoutBitmapFromAlpha(source.decodedBitmap, alphaMask, W, H),
    alphaMask,
    status: 'ready',
  })
}

/**
 * Produce a full-resolution cutout for `source`. In 'auto' mode, flat graphics on a uniform background are keyed by
 * colour (the salient-object models are unreliable when there is no single subject, e.g. a page of line art) and
 * everything else goes through the model; 'model' and 'color' force one path.
 */
export async function removeBackground(handle: ModelHandle, source: SourceImage, mode: MatteMode = 'auto'): Promise<CutoutResult> {
  if (mode !== 'model') {
    const keyed = await colorKeyCutout(handle, source, mode)
    if (keyed) return keyed
  }
  const { width: W, height: H } = source
  const matte = await runMatte(handle, source)

  // Upscale the matte to the full decoded resolution (FR-16) and keep it as the alpha mask.
  const { canvas: maskCanvas, ctx: maskCtx } = canvas2d(W, H, { willReadFrequently: true })
  maskCtx.imageSmoothingQuality = 'high'
  maskCtx.drawImage(matte, 0, 0, W, H)
  const maskPixels = maskCtx.getImageData(0, 0, W, H).data
  const alphaMask = new Uint8ClampedArray(W * H)
  for (let p = 0, i = 3; p < alphaMask.length; p++, i += 4) alphaMask[p] = maskPixels[i]

  const cutoutBitmap = await cutoutFromMask(source.decodedBitmap, maskCanvas, W, H)

  return createCutoutResult({
    sourceImageId: source.id,
    modelTier: handle.tier,
    matteSource: 'model',
    cutoutBitmap,
    alphaMask,
    status: 'ready',
  })
}
