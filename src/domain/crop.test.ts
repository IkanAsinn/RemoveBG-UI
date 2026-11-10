import { describe, expect, it } from 'vitest'
import { canApplyCrop, dragCrop, fullCrop, normalizeCrop } from './crop'

const W = 400
const H = 300
const r = { x: 100, y: 50, width: 200, height: 150 }

describe('crop geometry (FR-20)', () => {
  it('moves the body inside the image bounds', () => {
    expect(dragCrop(r, 'move', 30, -20, W, H)).toEqual({ x: 130, y: 30, width: 200, height: 150 })
    expect(dragCrop(r, 'move', 1000, 1000, W, H)).toEqual({ x: 200, y: 150, width: 200, height: 150 })
    expect(dragCrop(r, 'move', -1000, -1000, W, H)).toEqual({ x: 0, y: 0, width: 200, height: 150 })
  })

  it('drags each handle and keeps the opposite edges fixed', () => {
    expect(dragCrop(r, 'e', 50, 99, W, H)).toEqual({ x: 100, y: 50, width: 250, height: 150 })
    expect(dragCrop(r, 'w', -40, 0, W, H)).toEqual({ x: 60, y: 50, width: 240, height: 150 })
    expect(dragCrop(r, 'n', 0, 20, W, H)).toEqual({ x: 100, y: 70, width: 200, height: 130 })
    expect(dragCrop(r, 's', 0, 10, W, H)).toEqual({ x: 100, y: 50, width: 200, height: 160 })
    expect(dragCrop(r, 'se', 25, 25, W, H)).toEqual({ x: 100, y: 50, width: 225, height: 175 })
    expect(dragCrop(r, 'nw', -10, -10, W, H)).toEqual({ x: 90, y: 40, width: 210, height: 160 })
  })

  it('handles stop at the image bounds', () => {
    expect(dragCrop(r, 'se', 5000, 5000, W, H)).toEqual({ x: 100, y: 50, width: 300, height: 250 })
    expect(dragCrop(r, 'nw', -5000, -5000, W, H)).toEqual({ x: 0, y: 0, width: 300, height: 200 })
  })

  it('dragging to zero or negative size stops at 16 × 16', () => {
    expect(dragCrop(r, 'e', -1000, 0, W, H)).toEqual({ x: 100, y: 50, width: 16, height: 150 })
    expect(dragCrop(r, 'w', 1000, 0, W, H)).toEqual({ x: 284, y: 50, width: 16, height: 150 })
    expect(dragCrop(r, 'nw', 1000, 1000, W, H)).toEqual({ x: 284, y: 184, width: 16, height: 16 })
    expect(dragCrop(r, 'se', -1000, -1000, W, H)).toEqual({ x: 100, y: 50, width: 16, height: 16 })
  })

  it('Apply is disabled below the minimum; images smaller than 16 px cannot be cropped', () => {
    expect(canApplyCrop({ x: 0, y: 0, width: 16, height: 16 })).toBe(true)
    expect(canApplyCrop({ x: 0, y: 0, width: 15, height: 40 })).toBe(false)
    const tiny = fullCrop(10, 40)
    const dragged = dragCrop(tiny, 'e', -100, 0, 10, 40)
    expect(dragged.width).toBe(10) // cannot shrink below the image itself
    expect(canApplyCrop(dragged)).toBe(false)
  })

  it('results are whole pixels', () => {
    const d = dragCrop(r, 'se', 10.6, 3.2, W, H)
    expect(Number.isInteger(d.width) && Number.isInteger(d.height)).toBe(true)
  })

  it('a full-image crop is stored as no crop', () => {
    expect(normalizeCrop(fullCrop(W, H), W, H)).toBeNull()
    expect(normalizeCrop(r, W, H)).toEqual(r)
  })
})
