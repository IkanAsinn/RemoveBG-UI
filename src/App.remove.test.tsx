import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model/loader')>()),
  loadModel: vi.fn(),
}))
vi.mock('./matte/remove', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./matte/remove')>()),
  removeBackground: vi.fn(),
}))

const tinyHandle = { tier: 'tiny', backend: 'wasm' } as ModelHandle
const cutoutFor = (img: SourceImage) =>
  createCutoutResult({
    sourceImageId: img.id,
    modelTier: 'tiny',
    cutoutBitmap: { width: img.width, height: img.height, close: vi.fn() } as unknown as ImageBitmap,
    alphaMask: new Uint8ClampedArray(img.width * img.height),
    status: 'ready',
  })

const upload = () =>
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'cat.png', { type: 'image/png' })] } })

/** Resolvable promise so the test controls exactly when each step finishes. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })))
})
afterEach(() => {
  cleanup()
  sessionReset()
  vi.unstubAllGlobals()
  vi.mocked(loadModel).mockReset()
  vi.mocked(removeBackground).mockReset()
})

describe('tiny model removal flow (FR-7, FR-10, FR-16)', () => {
  it('shows "Preparing model" then "Removing background", then the full-resolution tiny cutout', async () => {
    const model = deferred<ModelHandle>()
    const removal = deferred<ReturnType<typeof cutoutFor>>()
    vi.mocked(loadModel).mockReturnValue(model.promise)
    vi.mocked(removeBackground).mockReturnValue(removal.promise)

    render(<App />)
    upload()
    expect((await screen.findByTestId('phase')).textContent).toContain('Preparing model')
    expect(removeBackground).not.toHaveBeenCalled()

    await act(async () => model.resolve(tinyHandle))
    expect(screen.getByTestId('phase').textContent).toContain('Removing background')
    await waitFor(() => expect(removeBackground).toHaveBeenCalledTimes(1))
    const [handle, source] = vi.mocked(removeBackground).mock.calls[0]
    expect(handle).toBe(tinyHandle)
    expect(source).toMatchObject({ fileName: 'cat.png', width: 4000, height: 3000 })

    await act(async () => removal.resolve(cutoutFor(source)))
    const view = screen.getByTestId('processing-view')
    await waitFor(() => expect(view.dataset.modelTier).toBe('tiny'))
    expect(view.dataset.cutoutSize).toBe('4000x3000')
    expect(screen.queryByTestId('phase')).toBeNull() // phase indicator gone once the result is shown
    const stored = Object.values(sessionStore.getState().cutouts)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ modelTier: 'tiny', status: 'ready', sourceImageId: source.id })
    expect(removeBackground).toHaveBeenCalledTimes(1) // not re-run after the result lands
  })

  it('a removal failure shows an error with Try again, which re-runs the model', async () => {
    vi.mocked(loadModel).mockResolvedValue(tinyHandle)
    vi.mocked(removeBackground)
      .mockRejectedValueOnce(new Error('session.run failed'))
      .mockImplementationOnce(async (_h, img) => cutoutFor(img))

    render(<App />)
    upload()
    expect((await screen.findByRole('alert')).textContent).toContain('Background removal failed for this image.')
    expect(screen.queryByTestId('phase')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('processing-view').dataset.modelTier).toBe('tiny'))
    expect(removeBackground).toHaveBeenCalledTimes(2)
  })

  it('Start over discards the image and its cutout', async () => {
    vi.mocked(loadModel).mockResolvedValue(tinyHandle)
    vi.mocked(removeBackground).mockImplementation(async (_h, img) => cutoutFor(img))
    render(<App />)
    upload()
    await waitFor(() => expect(screen.getByTestId('processing-view').dataset.modelTier).toBe('tiny'))
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(sessionStore.getState().cutouts).toEqual({})
    expect(sessionStore.getState().sourceImages).toEqual({})
  })
})
