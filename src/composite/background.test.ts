import { describe, expect, it, vi } from 'vitest'
import { createBackgroundSelection } from '../domain'
import { coverRect, drawBackground, hasBackgroundLayer, normalizeHex } from './background'

function fakeCtx() {
  const calls: Array<[string, ...unknown[]]> = []
  const ctx = {
    fillStyle: '' as unknown,
    imageSmoothingQuality: 'low',
    clearRect: vi.fn((...a: unknown[]) => calls.push(['clearRect', ...a])),
    fillRect: vi.fn((...a: unknown[]) => calls.push(['fillRect', ctx.fillStyle, ...a])),
    drawImage: vi.fn((...a: unknown[]) => calls.push(['drawImage', ...a.slice(1)])),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

describe('normalizeHex', () => {
  it('accepts 3/6-digit hex with or without # and normalises case', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('a1B2c3')).toBe('#a1b2c3')
    expect(normalizeHex('  #1F5EFF ')).toBe('#1f5eff')
  })
  it('rejects anything else', () => {
    for (const bad of ['', '#', '#12', '#1234', '#12345g', 'red', '#1f5eff0']) expect(normalizeHex(bad)).toBeNull()
  })
})

describe('drawBackground (FR-24, FR-25, FR-29)', () => {
  it('Transparent draws nothing but a clear, so alpha is preserved', () => {
    const { ctx, calls } = fakeCtx()
    drawBackground(ctx, createBackgroundSelection(), 100, 50)
    expect(calls).toEqual([['clearRect', 0, 0, 100, 50]])
    expect(hasBackgroundLayer(createBackgroundSelection())).toBe(false)
  })

  it('Solid color fills the whole output with the chosen colour', () => {
    const { ctx, calls } = fakeCtx()
    drawBackground(ctx, createBackgroundSelection({ type: 'solid', color: '#E8433A' }), 100, 50)
    expect(calls).toEqual([
      ['clearRect', 0, 0, 100, 50],
      ['fillRect', '#e8433a', 0, 0, 100, 50],
    ])
  })

  it('only the selected type is drawn: settings kept from other modes are ignored', () => {
    const bitmap = { width: 10, height: 10 } as ImageBitmap
    const kept = createBackgroundSelection({ type: 'transparent', color: '#000000', imageBitmap: bitmap })
    const { ctx, calls } = fakeCtx()
    drawBackground(ctx, kept, 100, 50)
    expect(calls).toEqual([['clearRect', 0, 0, 100, 50]])
    drawBackground(ctx, { ...kept, type: 'image' }, 100, 50)
    expect(calls.filter((c) => c[0] === 'fillRect')).toEqual([])
    expect(calls.at(-1)).toEqual(['drawImage', 0, -25, 100, 100])
  })

  it('a solid mode without a valid colour paints nothing', () => {
    expect(hasBackgroundLayer(createBackgroundSelection({ type: 'solid', color: 'nope' }))).toBe(false)
  })
})

describe('coverRect', () => {
  it('fills the output and keeps aspect ratio, centred', () => {
    expect(coverRect(200, 100, 100, 100)).toEqual({ x: -50, y: 0, width: 200, height: 100 })
    expect(coverRect(100, 100, 300, 150)).toEqual({ x: 0, y: -75, width: 300, height: 300 })
  })
})
