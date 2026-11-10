import { describe, expect, it, vi } from 'vitest'
import { createBackgroundSelection } from '../domain'
import { drawBackground } from './background'
import { createCssGradient, GRADIENTS, parseLinearGradient } from './gradients'

function gradientCtx() {
  const stops: Array<[number, string]> = []
  const line: number[] = []
  const ctx = {
    fillStyle: null as unknown,
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    createLinearGradient: vi.fn((...a: number[]) => {
      line.push(...a)
      return { addColorStop: (o: number, c: string) => stops.push([o, c]) }
    }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, stops, line, raw: ctx }
}

describe('parseLinearGradient', () => {
  it('reads angle, side keywords and explicit stops', () => {
    expect(parseLinearGradient('linear-gradient(135deg, #ff9a8b 0%, #ff6a88 55%, #ff99ac 100%)')).toEqual({
      angle: 135,
      stops: [
        { color: '#ff9a8b', offset: 0 },
        { color: '#ff6a88', offset: 0.55 },
        { color: '#ff99ac', offset: 1 },
      ],
    })
    expect(parseLinearGradient('linear-gradient(to right, red, blue)')!.angle).toBe(90)
    expect(parseLinearGradient('linear-gradient(red, blue)')!.angle).toBe(180) // CSS default
  })
  it('spreads missing positions evenly and keeps rgb() colours whole', () => {
    const g = parseLinearGradient('linear-gradient(90deg, rgb(1, 2, 3), #fff, #000 80%, #111)')!
    expect(g.stops.map((s) => s.color)).toEqual(['rgb(1, 2, 3)', '#fff', '#000', '#111'])
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.4, 0.8, 1])
  })
  it('rejects non-linear or single-stop values', () => {
    expect(parseLinearGradient('radial-gradient(red, blue)')).toBeNull()
    expect(parseLinearGradient('linear-gradient(90deg, red)')).toBeNull()
  })
  it('every bundled gradient parses', () => {
    for (const g of GRADIENTS) expect(parseLinearGradient(g.cssValue), g.id).not.toBeNull()
  })
})

describe('createCssGradient geometry (matches CSS)', () => {
  it('180deg runs top to bottom through the centre', () => {
    const { ctx, line } = gradientCtx()
    createCssGradient(ctx, 'linear-gradient(180deg, #000, #fff)', 400, 300)
    expect(line).toEqual([200, 0, 200, 300])
  })
  it('90deg runs left to right', () => {
    const { ctx, line } = gradientCtx()
    createCssGradient(ctx, 'linear-gradient(90deg, #000, #fff)', 400, 300)
    expect(line.map((v) => Math.round(v))).toEqual([0, 150, 400, 150])
  })
  it('45deg line length is |W sin a| + |H cos a| so the end stops reach the corners', () => {
    const { ctx, line } = gradientCtx()
    createCssGradient(ctx, 'linear-gradient(45deg, #000, #fff)', 400, 300)
    const len = Math.hypot(line[2] - line[0], line[3] - line[1])
    expect(len).toBeCloseTo((400 + 300) * Math.SQRT1_2, 6)
  })
})

describe('drawBackground with a gradient (FR-27, FR-29)', () => {
  it('fills the output with the selected bundled gradient at any output size', () => {
    const { ctx, stops, raw } = gradientCtx()
    drawBackground(ctx, createBackgroundSelection({ type: 'gradient', gradientId: 'ocean' }), 4000, 3000)
    expect(raw.createLinearGradient).toHaveBeenCalledWith(2000, 0, 2000, 3000)
    expect(stops).toEqual([
      [0, '#2e8bc0'],
      [1, '#0c2d48'],
    ])
    expect(raw.fillRect).toHaveBeenCalledWith(0, 0, 4000, 3000)
  })
  it('an unknown gradient id paints nothing', () => {
    const { ctx, raw } = gradientCtx()
    drawBackground(ctx, createBackgroundSelection({ type: 'gradient', gradientId: 'missing' }), 10, 10)
    expect(raw.fillRect).not.toHaveBeenCalled()
  })
})
