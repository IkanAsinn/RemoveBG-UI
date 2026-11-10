import { describe, expect, it } from 'vitest'
import { createCutoutResult, createEditState, editStateForImage, hasEdits, outputSize } from './index'

describe('edit helpers', () => {
  it('hasEdits: only strokes, a non-default edge, or a crop count as edits', () => {
    const e = createEditState('c1')
    expect(hasEdits(undefined)).toBe(false)
    expect(hasEdits(e)).toBe(false)
    expect(hasEdits({ ...e, brushMode: 'restore', brushRadius: 80 })).toBe(false) // tool settings, not edits
    expect(hasEdits({ ...e, edgeValue: 49 })).toBe(true)
    expect(hasEdits({ ...e, crop: { x: 0, y: 0, width: 16, height: 16 } })).toBe(true)
    expect(hasEdits({ ...e, strokes: [{ mode: 'erase', radius: 5, points: [{ x: 1, y: 1 }] }] })).toBe(true)
  })

  it('outputSize: full source resolution unless cropped', () => {
    const src = { width: 4032, height: 3024 }
    expect(outputSize(src, null)).toEqual({ width: 4032, height: 3024 })
    expect(outputSize(src, { ...createEditState('c'), crop: { x: 10, y: 10, width: 500, height: 400 } })).toEqual({ width: 500, height: 400 })
  })

  it('editStateForImage follows the image across cutout replacement', () => {
    const bmp = { close() {} } as unknown as ImageBitmap
    const tiny = createCutoutResult({ sourceImageId: 'img', modelTier: 'tiny', cutoutBitmap: bmp, alphaMask: new Uint8ClampedArray() })
    const full = createCutoutResult({ sourceImageId: 'img', modelTier: 'full', cutoutBitmap: bmp, alphaMask: new Uint8ClampedArray() })
    const e = createEditState(tiny.id)
    expect(editStateForImage({ cutouts: { [tiny.id]: tiny }, editStates: { [e.id]: e } }, 'img')).toBe(e)
    const moved = { ...e, cutoutId: full.id }
    expect(editStateForImage({ cutouts: { [full.id]: full }, editStates: { [e.id]: moved } }, 'img')).toBe(moved)
    expect(editStateForImage({ cutouts: { [full.id]: full }, editStates: { [e.id]: moved } }, 'other')).toBeUndefined()
  })
})
