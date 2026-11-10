import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeCanvas } from '../composite/output'
import { canvas2d } from '../matte/remove'
import { detectFormatSupport, encodeExport, resetFormatSupport } from './encode'

vi.mock('../composite/output', async (orig) => ({ ...(await orig<typeof import('../composite/output')>()), encodeCanvas: vi.fn() }))
vi.mock('../matte/remove', async (orig) => ({ ...(await orig<typeof import('../matte/remove')>()), canvas2d: vi.fn() }))
vi.mocked(canvas2d).mockImplementation(() => ({ canvas: {} as HTMLCanvasElement, ctx: { fillRect: vi.fn() } as unknown as CanvasRenderingContext2D }))
afterEach(() => {
  resetFormatSupport()
  vi.mocked(encodeCanvas).mockReset()
})

describe('encodeExport (LOCAL /export/encode)', () => {
  it('PNG and JXL use the default encoder settings; WebP is lossless (quality 1)', async () => {
    vi.mocked(encodeCanvas).mockResolvedValue(new Blob())
    const c = {} as HTMLCanvasElement
    await encodeExport(c, 'png')
    await encodeExport(c, 'webp')
    await encodeExport(c, 'jxl')
    expect(vi.mocked(encodeCanvas).mock.calls).toEqual([[c, 'image/png', undefined], [c, 'image/webp', 1], [c, 'image/jxl', undefined]])
  })
})

describe('detectFormatSupport (FR-32, OQ-6)', () => {
  it('probes the real encoders once; a format the browser cannot encode is unsupported', async () => {
    vi.mocked(encodeCanvas).mockImplementation(async (_c, type) => {
      if (type === 'image/jxl') throw new Error('browser returned image/png')
      return new Blob([], { type })
    })
    expect(await detectFormatSupport()).toEqual({ png: true, webp: true, jxl: false })
    await detectFormatSupport()
    expect(encodeCanvas).toHaveBeenCalledTimes(2) // webp + jxl, once
  })

  it('a browser without WebP encoding (Safari) gets WebP disabled too', async () => {
    vi.mocked(encodeCanvas).mockRejectedValue(new Error('no'))
    expect(await detectFormatSupport()).toEqual({ png: true, webp: false, jxl: false })
  })
})
