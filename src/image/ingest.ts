// LOCAL /image/ingest — validate an uploaded/pasted blob, decode it natively, return a SourceImage (FR-2, FR-5, FR-6, FR-8).
// No app-level file-size or pixel cap: whatever the browser decoder accepts is accepted.

import { createSourceImage, type SourceImage, type SourceKind } from '../domain'
import { decodeHeic, isHeif } from './heic'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  jxl: 'image/jxl',
  svg: 'image/svg+xml',
}

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/** Browsers often report an empty type for HEIC/AVIF, so fall back to the extension. */
export function mimeTypeOf(file: { name: string; type: string }): string {
  return file.type || EXT_MIME[extOf(file.name)] || ''
}

export const isImageFile = (file: File): boolean => mimeTypeOf(file).startsWith('image/')

/** FR-2: in single-image mode only the first image file of a selection/drop is ingested. */
export function firstImageFile(files: ArrayLike<File> | null | undefined): File | null {
  return Array.from(files ?? []).find(isImageFile) ?? null
}

export type IngestErrorCode = 'unsupported' | 'heic-failed'

const ERROR_TEXT: Record<IngestErrorCode, string> = {
  unsupported: 'Unsupported or corrupt image.',
  'heic-failed': 'HEIC decoding failed for this file.',
}

export class IngestError extends Error {
  readonly fileName: string
  readonly code: IngestErrorCode
  constructor(fileName: string, code: IngestErrorCode = 'unsupported') {
    super(`${fileName}: ${ERROR_TEXT[code]}`)
    this.name = 'IngestError'
    this.fileName = fileName
    this.code = code
  }
}

async function decodeNative(blob: Blob): Promise<ImageBitmap | null> {
  try {
    // imageOrientation: 'from-image' applies EXIF rotation so phone photos come out upright.
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    if (bitmap.width && bitmap.height) return bitmap
    bitmap.close()
  } catch {
    // fall through
  }
  return null
}

/** FR-5: native decode first; HEIC/HEIF that fails natively is retried with the bundled WASM decoder. */
export async function ingestImage(blob: Blob, fileName: string, sourceKind: SourceKind): Promise<SourceImage> {
  let bitmap = await decodeNative(blob)
  let decodePath: SourceImage['decodePath'] = 'native'
  if (!bitmap) {
    if (!(await isHeif(blob, fileName))) throw new IngestError(fileName)
    try {
      bitmap = await decodeHeic(blob)
      decodePath = 'wasm-heic'
    } catch {
      throw new IngestError(fileName, 'heic-failed')
    }
  }
  return createSourceImage({
    fileName,
    mimeType: mimeTypeOf({ name: fileName, type: blob.type }),
    byteSize: blob.size,
    width: bitmap.width,
    height: bitmap.height,
    sourceKind,
    originalBlob: blob,
    decodedBitmap: bitmap,
    decodePath,
  })
}
