import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editHistory, sessionReset, sessionStore, type CutoutResult, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'
import { zipStreaming } from './batch/queue'
import { needsUnloadConfirmation } from './session/unloadGuard'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({
  ...(await orig<typeof import('./matte/remove')>()),
  removeBackground: vi.fn(),
  cutoutBitmapFromAlpha: vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() })),
}))
vi.mock('./composite/output', async (orig) => ({
  ...(await orig<typeof import('./composite/output')>()),
  renderOutput: vi.fn(() => ({})),
  encodeCanvas: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

/** Dispatch a cancelable beforeunload; true when the app asked the browser to confirm. */
function leavingPrompts(): boolean {
  const e = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(e)
  return e.defaultPrevented
}
const cutoutFor = (img: SourceImage): CutoutResult =>
  createCutoutResult({
    sourceImageId: img.id,
    modelTier: 'tiny',
    cutoutBitmap: { width: img.width, height: img.height, close: vi.fn() } as unknown as ImageBitmap,
    alphaMask: new Uint8ClampedArray(4),
    status: 'ready',
  })
const png = (name: string) => new File(['x'], name, { type: 'image/png' })

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() })))
  vi.mocked(loadModel).mockResolvedValue({ tier: 'tiny', backend: 'wasm' } as ModelHandle)
  vi.mocked(removeBackground).mockImplementation(async (_h, img: SourceImage) => cutoutFor(img))
})
afterEach(() => {
  cleanup()
  sessionReset()
  editHistory.clear()
  vi.unstubAllGlobals()
})

describe('beforeunload (FR-52)', () => {
  it('any in-progress or unsaved condition requires confirmation', () => {
    const idle = { singleProcessing: false, singleEdited: false, batchProcessing: false, zipStreaming: false, batchUnsavedEdits: false }
    expect(needsUnloadConfirmation(idle)).toBe(false)
    for (const key of Object.keys(idle)) expect(needsUnloadConfirmation({ ...idle, [key]: true })).toBe(true)
  })

  it('single image: prompts while processing and with edits, not when idle or untouched', async () => {
    let finish: (c: CutoutResult) => void = () => {}
    vi.mocked(removeBackground).mockImplementation((_h, img) => new Promise((r) => (finish = () => r(cutoutFor(img)))))
    render(<App />)
    expect(leavingPrompts()).toBe(false) // empty home screen

    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [png('a.png')] } })
    await screen.findByText('a.png')
    await vi.waitFor(() => expect(removeBackground).toHaveBeenCalled())
    expect(leavingPrompts()).toBe(true) // removal running

    await act(async () => finish(cutoutFor(Object.values(sessionStore.getState().sourceImages)[0])))
    await screen.findByRole('complementary', { name: 'Editing tools' })
    expect(leavingPrompts()).toBe(false) // result shown, nothing edited

    const slider = screen.getByRole('slider', { name: 'Edge softness' })
    fireEvent.change(slider, { target: { value: '70' } })
    expect(leavingPrompts()).toBe(true) // unsaved edits
  })

  it('batch: prompts while processing, while zipping, and for edits not yet in a saved ZIP', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Process a batch' }))
    fireEvent.change(screen.getByTestId('batch-input'), { target: { files: [png('a.png'), png('b.png')] } })
    expect(leavingPrompts()).toBe(false) // queued only
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    expect(leavingPrompts()).toBe(true) // processing
    await screen.findByText('2 done · 0 failed')
    expect(leavingPrompts()).toBe(false)

    const job = Object.values(sessionStore.getState().batchJobs)[0]
    act(() => zipStreaming.set(job.id, true))
    expect(leavingPrompts()).toBe(true)
    act(() => zipStreaming.set(job.id, false))

    // Edit an item and return to the queue: the edits exist only in this tab.
    fireEvent.click(screen.getByRole('button', { name: 'Edit a.png' }))
    await screen.findByRole('complementary', { name: 'Editing tools' })
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '30' } })
    expect(leavingPrompts()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }))
    await screen.findByRole('table', { name: 'Batch queue' })
    expect(leavingPrompts()).toBe(true)
  })
})

describe('privacy (FR-51, NFR-2)', () => {
  it('a full session leaves nothing in localStorage, sessionStorage or cookies', async () => {
    render(<App />)
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [png('a.png')] } })
    await screen.findByRole('complementary', { name: 'Editing tools' })
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '70' } })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.cookie).toBe('')
  })
})
