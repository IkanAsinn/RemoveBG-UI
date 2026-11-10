// LOCAL /batch/validate (FR-38, FR-39, NFR-6). Limits are checked on the selection as a whole before anything is
// decoded or processed, so a blocked selection never creates a partial batch.

import { isImageFile } from '../image/ingest'

export const BATCH_MAX_FILES = 20
/** 100 MB, as specified in bytes by FR-39. */
export const BATCH_MAX_BYTES = 104_857_600

const MB = 1024 * 1024

/** "12.3 MB"; below 0.1 MB shows KB so small files do not read as 0.0 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 0.1 * MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

export type BatchValidation =
  | { ok: true; files: File[]; totalBytes: number; skipped: number }
  | { ok: false; code: 'too-many' | 'too-large' | 'empty'; message: string; totalBytes: number; skipped: number }

/**
 * Validate a batch selection. Non-image files are ignored (and counted in `skipped`); the 20-file and 100 MB limits
 * apply to the image files that would be processed. Total size is the sum of the selected file sizes.
 */
export function validateBatch(selection: ArrayLike<File>): BatchValidation {
  const all = Array.from(selection)
  const files = all.filter(isImageFile)
  const skipped = all.length - files.length
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  if (files.length === 0) return { ok: false, code: 'empty', message: 'Select one or more image files.', totalBytes, skipped }
  if (files.length > BATCH_MAX_FILES) {
    return { ok: false, code: 'too-many', message: 'Maximum 20 images per batch.', totalBytes, skipped }
  }
  if (totalBytes > BATCH_MAX_BYTES) {
    const exact = totalBytes.toLocaleString('en-US')
    // Two decimals when one would round down to "100.0 MB" and hide that the cap was exceeded.
    const shown = (totalBytes / MB).toFixed(totalBytes / MB < 100.05 ? 2 : 1)
    return {
      ok: false,
      code: 'too-large',
      message: `Selected images total ${shown} MB (${exact} bytes). The limit is 100 MB (104,857,600 bytes) per batch.`,
      totalBytes,
      skipped,
    }
  }
  return { ok: true, files, totalBytes, skipped }
}
