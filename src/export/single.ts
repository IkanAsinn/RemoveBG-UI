// Single-image export (FR-33…FR-37, NFR-7): pick the destination, render the composite at full output resolution with
// the shared pipeline, encode in the selected format, save as `{basename}-nobg.{ext}`. Nothing is added to the image
// (no watermark or branding, FR-34). Every failure leaves the session (edits, background, format) untouched.

import type { BackgroundSelection, CutoutResult, EditState, ExportFormat, SourceImage } from '../domain'
import { outputBounds, renderOutput } from '../composite/output'
import { encodeExport, EXPORT_LABEL } from './encode'
import { outputFileName } from './naming'
import { openSaveTarget, SaveBlockedError, type SaveTarget } from './save'

export type ExportOutcome =
  | { kind: 'saved'; fileName: string; width: number; height: number; bytes: number }
  | { kind: 'canceled' }
  | { kind: 'too-large' }
  | { kind: 'encode-failed'; format: ExportFormat }
  | { kind: 'blocked' }
  | { kind: 'save-failed' }

export const TOO_LARGE_MESSAGE = 'This image is too large to export on this browser.'

export function exportMessage(o: ExportOutcome): string {
  switch (o.kind) {
    case 'saved':
      return `Saved ${o.fileName} (${o.width} × ${o.height} px).`
    case 'canceled':
      return 'Save canceled. Nothing was written.'
    case 'too-large':
      return TOO_LARGE_MESSAGE
    case 'encode-failed':
      return `Could not encode the image as ${EXPORT_LABEL[o.format]}. Your edits and background are unchanged.`
    case 'blocked':
      return 'The download was blocked by the browser. Allow downloads for this site and try again.'
    case 'save-failed':
      return 'The file could not be saved. Your edits and background are unchanged.'
  }
}

export interface ExportInput {
  image: SourceImage
  cutout: CutoutResult
  edit: EditState | null
  background: BackgroundSelection
  format: ExportFormat
}

export interface ExportDeps {
  openTarget?: (fileName: string, format: ExportFormat) => Promise<SaveTarget | null>
  render?: typeof renderOutput
  encode?: typeof encodeExport
}

/** Output size in pixels: the source minus the applied crop (FR-31). */
export function exportDimensions(image: Pick<SourceImage, 'width' | 'height'>, edit: Pick<EditState, 'crop'> | null) {
  const b = outputBounds(image.width, image.height, edit?.crop ?? null)
  return { width: b.width, height: b.height }
}

export async function exportSingle(input: ExportInput, deps: ExportDeps = {}): Promise<ExportOutcome> {
  const { image, cutout, edit, background, format } = input
  const fileName = outputFileName(image.fileName, format)
  let target: SaveTarget | null
  try {
    target = await (deps.openTarget ?? openSaveTarget)(fileName, format)
  } catch (e) {
    return e instanceof SaveBlockedError ? { kind: 'blocked' } : { kind: 'save-failed' }
  }
  if (!target) return { kind: 'canceled' }

  let canvas: OffscreenCanvas | HTMLCanvasElement
  try {
    canvas = (deps.render ?? renderOutput)({
      source: image.decodedBitmap,
      width: image.width,
      height: image.height,
      alphaMask: cutout.alphaMask,
      edit,
      background,
    })
  } catch {
    // Canvas allocation or pixel readback beyond this browser's limits. Never retried at a smaller size (NFR-7).
    await target.discard()
    return { kind: 'too-large' }
  }

  let blob: Blob
  try {
    blob = await (deps.encode ?? encodeExport)(canvas, format)
  } catch {
    await target.discard()
    return { kind: 'encode-failed', format }
  }

  try {
    await target.write(blob)
  } catch (e) {
    await target.discard()
    return e instanceof SaveBlockedError ? { kind: 'blocked' } : { kind: 'save-failed' }
  }
  return { kind: 'saved', fileName, width: canvas.width, height: canvas.height, bytes: blob.size }
}
