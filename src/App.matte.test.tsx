import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editStateForImage, sessionReset, sessionStore, type MatteMode, type SourceImage } from './domain'
import { detectCapabilities, detectWebGPU } from './model/capabilities'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))
vi.mock('./model/capabilities', async (orig) => ({
  ...(await orig<typeof import('./model/capabilities')>()),
  detectCapabilities: vi.fn(),
  detectWebGPU: vi.fn(),
}))

const tinyHandle = { tier: 'tiny', backend: 'wasm' } as ModelHandle
const fullHandle = { tier: 'full', backend: 'wasm' } as ModelHandle
const view = () => screen.getByTestId('processing-view')
const fullLoads = () => vi.mocked(loadModel).mock.calls.filter(([tier]) => tier === 'full')
const image = () => Object.values(sessionStore.getState().sourceImages)[0]
const edit = () => editStateForImage(sessionStore.getState(), image().id)!
const method = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement

/** 'auto' resolves to a colour key, as for a line-art upload. */
const fakeRemove = async (h: ModelHandle, img: SourceImage, mode: MatteMode = 'auto') =>
  createCutoutResult({
    sourceImageId: img.id,
    modelTier: h.tier,
    matteSource: mode === 'model' ? 'model' : 'color',
    cutoutBitmap: { width: img.width, height: img.height, close: vi.fn() } as unknown as ImageBitmap,
    alphaMask: new Uint8ClampedArray(4),
    status: 'ready',
  })

async function openLineArt() {
  render(<App />)
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'lines.png', { type: 'image/png' })] } })
  await screen.findByRole('complementary', { name: 'Editing tools' })
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3000, height: 2000, close: vi.fn() })))
  vi.mocked(detectCapabilities).mockReturnValue({ webgl2: true, wasmSimd: true })
  vi.mocked(detectWebGPU).mockResolvedValue(false)
  vi.mocked(loadModel).mockImplementation(async (tier) => (tier === 'tiny' ? tinyHandle : fullHandle))
  vi.mocked(removeBackground).mockImplementation(fakeRemove)
})
afterEach(() => {
  cleanup()
  sessionReset()
  vi.unstubAllGlobals()
  vi.mocked(loadModel).mockReset()
  vi.mocked(removeBackground).mockReset()
})

describe('cutout method: colour key for flat graphics', () => {
  it('a colour-keyed graphic never fetches the full model (it would only make the matte worse)', async () => {
    await openLineArt()
    expect(vi.mocked(removeBackground).mock.calls[0][2] ?? 'auto').toBe('auto')
    expect(view().dataset.matteSource).toBe('color')
    expect(method('Background colour').checked).toBe(true)
    await act(async () => {}) // give the upgrade hook a chance to start
    expect(fullLoads()).toHaveLength(0)
    expect(view().dataset.fullModel).toBe('idle')
  })

  it('switching to AI subject redoes the cutout with the model, keeps edits, then upgrades to the full model', async () => {
    await openLineArt()
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '70' } })
    const editId = edit().id

    let finishFull!: (h: ModelHandle) => void
    vi.mocked(loadModel).mockImplementation(async (tier) => (tier === 'tiny' ? tinyHandle : new Promise<ModelHandle>((r) => (finishFull = r))))
    let finishRemove!: () => void
    vi.mocked(removeBackground).mockImplementationOnce(async (h, img, mode) => {
      await new Promise<void>((r) => (finishRemove = r))
      return fakeRemove(h, img, mode)
    })
    fireEvent.click(method('AI subject'))
    // While the cutout is redone, the chosen method shows as selected and the switch is locked.
    await waitFor(() => expect(screen.getByTestId('cutout-method').textContent).toContain('Updating cutout'))
    expect(method('AI subject').checked).toBe(true)
    expect(method('Background colour').disabled).toBe(true)
    expect(view().dataset.matteSource).toBe('color')
    await act(async () => finishRemove())
    await waitFor(() => expect(view().dataset.matteSource).toBe('model'))
    expect(method('Background colour').disabled).toBe(false)
    expect(edit()).toMatchObject({ id: editId, edgeValue: 70 })
    await waitFor(() => expect(finishFull).toBeDefined())
    await act(async () => finishFull(fullHandle))
    await waitFor(() => expect(view().dataset.modelTier).toBe('full'))
    expect(vi.mocked(removeBackground).mock.calls.map((c) => c[2] ?? 'auto')).toEqual(['auto', 'model', 'model'])
    expect(view().dataset.matteSource).toBe('model')
    expect(view().dataset.fullModel).toBe('done')
    expect(Object.values(sessionStore.getState().cutouts)).toHaveLength(1)
    expect(edit()).toMatchObject({ id: editId, edgeValue: 70 }) // same edit state, moved onto the new cutout

    fireEvent.click(method('Background colour'))
    await waitFor(() => expect(view().dataset.matteSource).toBe('color'))
    expect(vi.mocked(removeBackground).mock.calls.at(-1)?.[2]).toBe('color')
    expect(view().dataset.fullModel).toBe('idle')
    expect(edit()).toMatchObject({ id: editId, edgeValue: 70 })
  })
})

describe('edge-aware brush controls', () => {
  it('"Auto-detect edges" is off by default; turning it on shows the tolerance and stores both as tool settings', async () => {
    await openLineArt()
    const toggle = screen.getByRole('checkbox', { name: 'Auto-detect edges' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.queryByRole('slider', { name: 'Edge tolerance' })).toBeNull()

    fireEvent.click(toggle)
    expect(edit()).toMatchObject({ brushEdgeAware: true, brushTolerance: 30 })
    expect(screen.getByTestId('source-preview').dataset.brushEdges).toBe('on')
    fireEvent.change(screen.getByRole('slider', { name: 'Edge tolerance' }), { target: { value: '55' } })
    expect(edit().brushTolerance).toBe(55)
    // Tool settings are not edits: nothing to reset or undo.
    expect((screen.getByRole('button', { name: 'Reset edits' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
