// FR-20 crop geometry, in integer image pixels. Pure functions shared by pointer and keyboard input.

import { CROP_MIN_SIZE, type CropRect } from './types'

export const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type CropHandle = (typeof CROP_HANDLES)[number] | 'move'

export function fullCrop(width: number, height: number): CropRect {
  return { x: 0, y: 0, width, height }
}

/** FR-20 edge case: Apply is disabled below the 16 × 16 minimum (only possible for tiny source images). */
export function canApplyCrop(rect: CropRect) {
  return rect.width >= CROP_MIN_SIZE && rect.height >= CROP_MIN_SIZE
}

/** A crop covering the whole image is stored as "no crop". */
export function normalizeCrop(rect: CropRect, width: number, height: number): CropRect | null {
  return rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height ? null : { ...rect }
}

const clampInt = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)))

/**
 * Move the body or one handle of `start` by (dx, dy) image pixels. The result stays inside the image and never
 * shrinks below the minimum size (or the image size, when the image itself is smaller than the minimum).
 */
export function dragCrop(start: CropRect, handle: CropHandle, dx: number, dy: number, width: number, height: number): CropRect {
  const minW = Math.min(CROP_MIN_SIZE, width)
  const minH = Math.min(CROP_MIN_SIZE, height)
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height

  if (handle === 'move') {
    const x = clampInt(start.x + dx, 0, width - start.width)
    const y = clampInt(start.y + dy, 0, height - start.height)
    return { x, y, width: start.width, height: start.height }
  }
  if (handle.includes('w')) left = clampInt(left + dx, 0, right - minW)
  if (handle.includes('e')) right = clampInt(right + dx, left + minW, width)
  if (handle.includes('n')) top = clampInt(top + dy, 0, bottom - minH)
  if (handle.includes('s')) bottom = clampInt(bottom + dy, top + minH, height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}
