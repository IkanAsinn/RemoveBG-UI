// LOCAL /export/encode (FR-30, FR-32, FR-36, FR-37). Encodes a composited canvas in the selected format. A failure
// throws EncodeError; the caller reports it and keeps the session. There is never a silent switch to another format:
// encodeCanvas rejects any blob whose type is not the requested one (browsers fall back to PNG for unknown types).
//
// OQ-6 (decided): a format this browser cannot encode natively stays visible but disabled, with the reason. Support
// is detected by encoding a tiny canvas with the real encoder, never by user-agent sniffing.
// WebP is lossless (quality 1.0, which Chromium encodes as VP8L) so cutout edges and alpha stay exact, like PNG.

import { EXPORT_FORMATS, type ExportFormat } from '../domain'
import { encodeCanvas } from '../composite/output'
import { canvas2d } from '../matte/remove'

export const EXPORT_MIME: Record<ExportFormat, string> = { png: 'image/png', webp: 'image/webp', jxl: 'image/jxl' }
export const EXPORT_LABEL: Record<ExportFormat, string> = { png: 'PNG', webp: 'WebP', jxl: 'JXL' }
const QUALITY: Partial<Record<ExportFormat, number>> = { webp: 1 }

/** Encode `canvas` as `format` at its own size. PNG and WebP are lossless and keep alpha. */
export function encodeExport(canvas: OffscreenCanvas | HTMLCanvasElement, format: ExportFormat): Promise<Blob> {
  return encodeCanvas(canvas, EXPORT_MIME[format], QUALITY[format])
}

export type FormatSupport = Record<ExportFormat, boolean>

let probe: Promise<FormatSupport> | null = null

/** Which formats this browser can encode natively (probed once per tab). PNG is required by NFR-3. */
export function detectFormatSupport(): Promise<FormatSupport> {
  probe ??= (async () => {
    const support = { png: true, webp: false, jxl: false } as FormatSupport
    for (const f of EXPORT_FORMATS) {
      if (f === 'png') continue
      try {
        const { canvas, ctx } = canvas2d(2, 2)
        ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'
        ctx.fillRect(0, 0, 1, 1)
        await encodeExport(canvas, f)
        support[f] = true
      } catch {
        support[f] = false
      }
    }
    return support
  })()
  return probe
}

/** Test helper. */
export function resetFormatSupport() {
  probe = null
}
