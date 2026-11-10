import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundSelection } from '../domain'
import { canvas2d } from '../matte/remove'
import { backgroundLayer, compositeCutout } from './background'
import { outputBounds, renderOutput } from './output'

// Fake 2D canvases that record calls; enough to check the compositing order and output bounds.
type Call = [string, ...unknown[]]
interface Fake { width: number; height: number; calls: Call[]; id: number }
let made: Fake[] = []
function fakeCanvas(width: number, height: number) {
  const canvas: Fake = { width, height, calls: [], id: made.length }
  made.push(canvas)
  let data = new Uint8ClampedArray(width * height * 4)
  const rec = (name: string) => (...a: unknown[]) => void canvas.calls.push([name, ...a.map((v) => ((v as Fake)?.calls ? `canvas#${(v as Fake).id}` : v))])
  const ctx = {
    canvas,
    clearRect: rec('clearRect'),
    fillRect: rec('fillRect'),
    drawImage: rec('drawImage'),
    set fillStyle(v: string) { canvas.calls.push(['fillStyle', v]) },
    getImageData: () => ({ data }),
    putImageData: (img: ImageData) => { data = img.data },
  }
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx: ctx as unknown as CanvasRenderingContext2D }
}
vi.mock('../matte/remove', async (orig) => ({ ...(await orig<typeof import('../matte/remove')>()), canvas2d: vi.fn() }))
vi.stubGlobal('ImageData', function (this: object, data: Uint8ClampedArray, width: number, height: number) { Object.assign(this, { data, width, height }) })
vi.mocked(canvas2d).mockImplementation(fakeCanvas as never)
afterEach(() => (made = []))

const source = {} as CanvasImageSource
const input = (over: object = {}) => ({ source, width: 40, height: 30, alphaMask: new Uint8ClampedArray(40 * 30).fill(255), background: createBackgroundSelection(), ...over })

describe('compositing pipeline (FR-29, NFR-7)', () => {
  it('compositeCutout draws the background layer first, then the cutout, into the same destination', () => {
    const { ctx, canvas } = fakeCanvas(10, 10)
    const layer = fakeCanvas(10, 10).canvas
    const cut = fakeCanvas(100, 100).canvas
    compositeCutout(ctx, cut, { x: 20, y: 30, width: 40, height: 40 }, { x: 1, y: 2, width: 4, height: 4 }, layer)
    expect((canvas as unknown as Fake).calls).toEqual([
      ['clearRect', 1, 2, 4, 4],
      ['drawImage', 'canvas#1', 1, 2, 4, 4, 1, 2, 4, 4],
      ['drawImage', 'canvas#2', 20, 30, 40, 40, 1, 2, 4, 4],
    ])
  })

  it('Transparent has no background layer; other modes paint one at the requested size', () => {
    expect(backgroundLayer(createBackgroundSelection(), 10, 10, canvas2d)).toBeNull()
    const layer = backgroundLayer(createBackgroundSelection({ type: 'solid', color: '#ff0000' }), 12, 8, canvas2d) as unknown as Fake
    expect([layer.width, layer.height]).toEqual([12, 8])
    expect(layer.calls).toContainEqual(['fillStyle', '#ff0000'])
  })

  it('Transparent, uncropped: output is the full-resolution cutout itself (alpha kept, no extra canvas)', () => {
    const out = renderOutput(input()) as unknown as Fake
    expect([out.width, out.height]).toEqual([40, 30])
    expect(made).toHaveLength(1)
  })

  it('crop + background: output is exactly the crop at 1:1, background behind the cropped cutout', () => {
    const out = renderOutput(input({
      edit: { edgeValue: 50, strokes: [], crop: { x: 5, y: 6, width: 20, height: 10 } },
      background: createBackgroundSelection({ type: 'solid', color: '#00ff00' }),
    })) as unknown as Fake
    expect([out.width, out.height]).toEqual([20, 10])
    const [full, layer] = made
    expect([layer.width, layer.height]).toEqual([20, 10])
    expect(out.calls).toEqual([
      ['clearRect', 0, 0, 20, 10],
      ['drawImage', `canvas#${layer.id}`, 0, 0, 20, 10, 0, 0, 20, 10],
      ['drawImage', `canvas#${full.id}`, 5, 6, 20, 10, 0, 0, 20, 10],
    ])
  })

  it('crop alone (Transparent) still crops without scaling', () => {
    const out = renderOutput(input({ edit: { edgeValue: 50, strokes: [], crop: { x: 0, y: 0, width: 40, height: 15 } } })) as unknown as Fake
    expect([out.width, out.height]).toEqual([40, 15])
    expect(out.calls.filter((c) => c[0] === 'drawImage')).toEqual([['drawImage', 'canvas#0', 0, 0, 40, 15, 0, 0, 40, 15]])
  })

  it('outputBounds is the whole image without a crop and clamps a crop to the image', () => {
    expect(outputBounds(40, 30, null)).toEqual({ x: 0, y: 0, width: 40, height: 30 })
    expect(outputBounds(40, 30, { x: 30, y: -2, width: 50, height: 10 })).toEqual({ x: 30, y: 0, width: 10, height: 10 })
  })
})
