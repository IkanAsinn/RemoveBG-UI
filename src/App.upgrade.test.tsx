import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editStateForImage, sessionReset, sessionStore, type SourceImage } from './domain'
import { detectCapabilities, detectWebGPU } from './model/capabilities'
import { GpuLostError, loadModel, ModelLoadError, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))
vi.mock('./model/capabilities', async (orig) => ({
  ...(await orig<typeof import('./model/capabilities')>()),
  detectCapabilities: vi.fn(),
  detectWebGPU: vi.fn(),
}))

const tinyHandle = { tier: 'tiny', backend: 'wasm' } as ModelHandle
const fullHandle = (backend: 'webgpu' | 'wasm', gpuLost?: Promise<string>) => ({ tier: 'full', backend, gpuLost }) as ModelHandle
const cutout = (img: SourceImage, tier: 'tiny' | 'full') =>
  createCutoutResult({
    sourceImageId: img.id,
    modelTier: tier,
    cutoutBitmap: { width: img.width, height: img.height, close: vi.fn() } as unknown as ImageBitmap,
    alphaMask: new Uint8ClampedArray(4),
    status: 'ready',
  })

const view = () => screen.getByTestId('processing-view')
const fullLoads = () => vi.mocked(loadModel).mock.calls.filter(([tier]) => tier === 'full')
const storedTiers = () => Object.values(sessionStore.getState().cutouts).map((c) => c.modelTier)

async function uploadAndAwaitTiny() {
  render(<App />)
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'dog.jpg', { type: 'image/jpeg' })] } })
  await waitFor(() => expect(view().dataset.modelTier).toBeDefined())
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3000, height: 2000, close: vi.fn() })))
  vi.mocked(detectCapabilities).mockReturnValue({ webgl2: true, wasmSimd: true })
  vi.mocked(detectWebGPU).mockResolvedValue(true)
  vi.mocked(removeBackground).mockImplementation(async (h, img) => cutout(img, h.tier))
})
afterEach(() => {
  cleanup()
  sessionReset()
  vi.unstubAllGlobals()
  vi.mocked(loadModel).mockReset()
  vi.mocked(removeBackground).mockReset()
})

describe('full-model upgrade (FR-11–FR-14, NFR-5)', () => {
  it('capable device: tiny result shows first, then "Applying full model", then the full cutout replaces it', async () => {
    let finishFull!: (h: ModelHandle) => void
    vi.mocked(loadModel).mockImplementation(async (tier) =>
      tier === 'tiny' ? tinyHandle : new Promise<ModelHandle>((r) => (finishFull = r)),
    )
    await uploadAndAwaitTiny()
    expect(view().dataset.modelTier).toBe('tiny') // tiny result displayed before the full attempt finishes
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toContain('Applying full model'))
    expect(fullLoads()[0][1]).toMatchObject({ backend: 'webgpu' })

    await act(async () => finishFull(fullHandle('webgpu')))
    await waitFor(() => expect(view().dataset.modelTier).toBe('full'))
    expect(view().dataset.fullModel).toBe('done')
    expect(storedTiers()).toEqual(['full']) // tiny replaced
    expect(screen.queryByTestId('phase')).toBeNull()
  })

  it('edits made on the tiny result while the full model loads carry over to the full cutout', async () => {
    let finishFull!: (h: ModelHandle) => void
    vi.mocked(loadModel).mockImplementation(async (tier) =>
      tier === 'tiny' ? tinyHandle : new Promise<ModelHandle>((r) => (finishFull = r)),
    )
    await uploadAndAwaitTiny()
    await screen.findByRole('complementary', { name: 'Editing tools' })
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '30' } })
    const imageId = Object.keys(sessionStore.getState().sourceImages)[0]
    const before = editStateForImage(sessionStore.getState(), imageId)!

    await waitFor(() => expect(finishFull).toBeDefined())
    await act(async () => finishFull(fullHandle('webgpu')))
    await waitFor(() => expect(view().dataset.modelTier).toBe('full'))
    const after = editStateForImage(sessionStore.getState(), imageId)!
    expect(after).toMatchObject({ id: before.id, edgeValue: 30 })
    expect(Object.keys(sessionStore.getState().editStates)).toEqual([before.id])
  })

  it('uses multi-threaded WASM when no WebGPU adapter exists', async () => {
    vi.mocked(detectWebGPU).mockResolvedValue(false)
    vi.mocked(loadModel).mockImplementation(async (tier, o) => (tier === 'tiny' ? tinyHandle : fullHandle(o!.backend!)))
    await uploadAndAwaitTiny()
    await waitFor(() => expect(view().dataset.modelTier).toBe('full'))
    expect(fullLoads()[0][1]).toMatchObject({ backend: 'wasm' })
  })

  it.each([
    [{ webgl2: false, wasmSimd: true }],
    [{ webgl2: true, wasmSimd: false }],
  ])('failed capability check %o never fetches the full model and keeps the tiny result', async (caps) => {
    vi.mocked(detectCapabilities).mockReturnValue(caps)
    vi.mocked(loadModel).mockResolvedValue(tinyHandle)
    await uploadAndAwaitTiny()
    await waitFor(() => expect(view().dataset.fullModel).toBe('skipped'))
    expect(fullLoads()).toHaveLength(0)
    expect(view().dataset.modelTier).toBe('tiny')
    expect(screen.queryByTestId('upgrade-notice')).toBeNull()
  })

  it('full-model failure keeps the tiny result and "Retry full model" works', async () => {
    vi.mocked(loadModel).mockImplementation(async (tier) => {
      if (tier === 'tiny') return tinyHandle
      if (fullLoads().length === 1) throw new ModelLoadError('full', 'fetch', 'offline')
      return fullHandle('webgpu')
    })
    await uploadAndAwaitTiny()
    const notice = await screen.findByTestId('upgrade-notice')
    expect(notice.textContent).toContain('The full model could not be applied')
    expect(view().dataset.modelTier).toBe('tiny')
    expect(storedTiers()).toEqual(['tiny'])

    fireEvent.click(screen.getByRole('button', { name: 'Retry full model' }))
    await waitFor(() => expect(view().dataset.modelTier).toBe('full'))
    expect(fullLoads()).toHaveLength(2)
    expect(screen.queryByTestId('upgrade-notice')).toBeNull()
  })

  it('a run failure (not a fetch failure) also keeps the tiny result', async () => {
    vi.mocked(loadModel).mockImplementation(async (tier) => (tier === 'tiny' ? tinyHandle : fullHandle('webgpu')))
    vi.mocked(removeBackground).mockImplementation(async (h, img) => {
      if (h.tier === 'full') throw new Error('session.run OOM')
      return cutout(img, 'tiny')
    })
    await uploadAndAwaitTiny()
    await screen.findByTestId('upgrade-notice')
    expect(storedTiers()).toEqual(['tiny'])
  })

  it('GPU device loss mid-run shows "Full model interrupted." + Retry, keeps tiny, and retries on WASM', async () => {
    let loseGpu!: (reason: string) => void
    const gpuLost = new Promise<string>((r) => (loseGpu = r))
    vi.mocked(loadModel).mockImplementation(async (tier, o) =>
      tier === 'tiny' ? tinyHandle : o!.backend === 'webgpu' ? fullHandle('webgpu', gpuLost) : fullHandle('wasm'),
    )
    // Like the real worker session: the in-flight run rejects with GpuLostError the moment the device is lost.
    vi.mocked(removeBackground).mockImplementation(async (h, img) =>
      h.tier === 'full' && h.backend === 'webgpu'
        ? gpuLost.then((reason) => Promise.reject(new GpuLostError(reason)))
        : cutout(img, h.tier),
    )
    await uploadAndAwaitTiny()
    await waitFor(() => expect(view().dataset.fullModel).toBe('running'))

    await act(async () => loseGpu('destroyed'))
    const notice = await screen.findByTestId('upgrade-notice')
    expect(notice.textContent).toContain('Full model interrupted.')
    expect(view().dataset.modelTier).toBe('tiny')
    expect(storedTiers()).toEqual(['tiny'])

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(view().dataset.modelTier).toBe('full'))
    expect(fullLoads().at(-1)![1]).toMatchObject({ backend: 'wasm' })
  })
})
