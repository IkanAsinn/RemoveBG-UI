import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundSelection, createCutoutResult, createEditState, createSourceImage } from '../domain'
import { CanvasTooLargeError } from '../matte/remove'
import { EncodeError } from '../composite/output'
import { exportDimensions, exportMessage, exportSingle, type ExportDeps } from './single'
import { openSaveTarget, SaveBlockedError, type SaveTarget } from './save'

const image = createSourceImage({
  fileName: 'Holiday Photo.final.HEIC', mimeType: 'image/heic', byteSize: 1, width: 4000, height: 3000,
  sourceKind: 'upload', originalBlob: new Blob(), decodedBitmap: {} as ImageBitmap, decodePath: 'wasm-heic',
})
const cutout = createCutoutResult({ sourceImageId: image.id, modelTier: 'tiny', cutoutBitmap: {} as ImageBitmap, alphaMask: new Uint8ClampedArray(1), status: 'ready' })
const input = { image, cutout, edit: null, background: createBackgroundSelection(), format: 'png' as const }

function target(fail?: Error) {
  return { write: vi.fn(async () => { if (fail) throw fail }), discard: vi.fn(async () => {}) } satisfies SaveTarget
}
const deps = (t: SaveTarget | null, over: Partial<ExportDeps> = {}): ExportDeps => ({
  openTarget: vi.fn(async () => t),
  render: vi.fn(() => ({ width: 4000, height: 3000 }) as HTMLCanvasElement),
  encode: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('exportSingle (FR-33…FR-36, NFR-7)', () => {
  it('renders at full resolution, encodes PNG and saves {basename}-nobg.png', async () => {
    const t = target()
    const d = deps(t)
    const out = await exportSingle(input, d)
    expect(out).toEqual({ kind: 'saved', fileName: 'Holiday Photo.final-nobg.png', width: 4000, height: 3000, bytes: 3 })
    expect(d.openTarget).toHaveBeenCalledWith('Holiday Photo.final-nobg.png', 'png')
    expect(d.render).toHaveBeenCalledWith(expect.objectContaining({ width: 4000, height: 3000, source: image.decodedBitmap }))
    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 'png')
    expect(t.write).toHaveBeenCalledOnce()
  })

  it('canceling the save picker renders and writes nothing', async () => {
    const d = deps(null)
    expect(await exportSingle(input, d)).toEqual({ kind: 'canceled' })
    expect(d.render).not.toHaveBeenCalled()
  })

  it('canvas over the browser limit: too-large error, no file, no smaller retry', async () => {
    const t = target()
    const d = deps(t, { render: vi.fn(() => { throw new CanvasTooLargeError() }) })
    const out = await exportSingle(input, d)
    expect(out).toEqual({ kind: 'too-large' })
    expect(exportMessage(out)).toBe('This image is too large to export on this browser.')
    expect(d.render).toHaveBeenCalledOnce()
    expect(t.write).not.toHaveBeenCalled()
    expect(t.discard).toHaveBeenCalledOnce()
  })

  it('encode failure reports the format and never falls back to another one', async () => {
    const t = target()
    const d = deps(t, { encode: vi.fn(async () => { throw new EncodeError() }) })
    const out = await exportSingle(input, d)
    expect(out).toEqual({ kind: 'encode-failed', format: 'png' })
    expect(exportMessage(out)).toBe('Could not encode the image as PNG. Your edits and background are unchanged.')
    expect(d.encode).toHaveBeenCalledOnce()
    expect(t.write).not.toHaveBeenCalled()
  })

  it('a blocked download is reported as blocked', async () => {
    expect(await exportSingle(input, deps(target(new SaveBlockedError())))).toEqual({ kind: 'blocked' })
    expect(await exportSingle(input, { ...deps(null), openTarget: async () => { throw new SaveBlockedError() } })).toEqual({ kind: 'blocked' })
  })

  it('output dimensions are the source minus the crop (FR-31)', () => {
    expect(exportDimensions(image, null)).toEqual({ width: 4000, height: 3000 })
    const edit = createEditState(cutout.id, { crop: { x: 100, y: 50, width: 1200, height: 900 } })
    expect(exportDimensions(image, edit)).toEqual({ width: 1200, height: 900 })
  })
})

describe('openSaveTarget (LOCAL /file/save)', () => {
  it('uses the save picker; canceling it resolves to null', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    expect(await openSaveTarget('a-nobg.png', 'png')).toBeNull()
  })

  it('writes the blob into the picked file; a refused picker is reported as blocked', async () => {
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const picker = vi.fn(async () => ({ createWritable: async () => writable }))
    vi.stubGlobal('showSaveFilePicker', picker)
    const t = (await openSaveTarget('a-nobg.png', 'png'))!
    const blob = new Blob(['x'], { type: 'image/png' })
    await t.write(blob)
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'a-nobg.png', types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] })
    expect(writable.write).toHaveBeenCalledWith(blob)
    expect(writable.close).toHaveBeenCalledOnce()

    vi.stubGlobal('showSaveFilePicker', vi.fn(() => Promise.reject(new DOMException('no gesture', 'SecurityError'))))
    await expect(openSaveTarget('a-nobg.png', 'png')).rejects.toBeInstanceOf(SaveBlockedError)
  })

  it('discard removes a picked file only while it is still empty (never an existing file)', async () => {
    for (const [size, removed] of [[0, true], [11, false]] as const) {
      const remove = vi.fn(async () => {})
      vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: vi.fn(), getFile: async () => ({ size }), remove })))
      await (await openSaveTarget('a-nobg.png', 'png'))!.discard()
      expect(remove).toHaveBeenCalledTimes(removed ? 1 : 0)
    }
  })

  it('without the picker it starts a normal download with the suggested name', async () => {
    vi.stubGlobal('showSaveFilePicker', undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('a-nobg.png')
      expect(this.href).toMatch(/^blob:/)
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local/1'), revokeObjectURL: vi.fn() }))
    const t = (await openSaveTarget('a-nobg.png', 'png'))!
    await t.write(new Blob(['x']))
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })
})
