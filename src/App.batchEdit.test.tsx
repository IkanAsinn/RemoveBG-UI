import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editHistory, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'
import { zipStreaming } from './batch/queue'

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

const job = () => Object.values(sessionStore.getState().batchJobs)[0]
const rows = () => within(screen.getByRole('table', { name: 'Batch queue' })).getAllByRole('row').slice(1)

beforeEach(() => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (blob: File) => {
      if (blob.name?.startsWith('corrupt')) throw new Error('decode')
      return { width: 640, height: 480, close: vi.fn() }
    }),
  )
  vi.mocked(loadModel).mockResolvedValue({ tier: 'tiny', backend: 'wasm' } as ModelHandle)
  vi.mocked(removeBackground).mockImplementation(async (_h, img: SourceImage) =>
    createCutoutResult({
      sourceImageId: img.id,
      modelTier: 'tiny',
      cutoutBitmap: { width: img.width, height: img.height, close: vi.fn() } as unknown as ImageBitmap,
      alphaMask: new Uint8ClampedArray(4),
      status: 'ready',
    }),
  )
})
afterEach(() => {
  cleanup()
  sessionReset()
  editHistory.clear()
  vi.unstubAllGlobals()
})

async function processedQueue() {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Process a batch' }))
  const files = ['a.png', 'corrupt.png', 'c.png'].map((n) => new File(['x'], n, { type: 'image/png' }))
  fireEvent.change(screen.getByTestId('batch-input'), { target: { files } })
  fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
  await screen.findByText('2 done · 1 failed')
}

describe('per-item batch editing (FR-43)', () => {
  it('only Done rows expose an edit action', async () => {
    await processedQueue()
    expect(rows().map((r) => within(r).queryByRole('button')?.getAttribute('aria-label') ?? null)).toEqual([
      'Edit a.png',
      null,
      'Edit c.png',
    ])
  })

  it('edits save to the item, the row shows Edited, and the queue and batch status are preserved', async () => {
    await processedQueue()
    fireEvent.click(screen.getByRole('button', { name: 'Edit a.png' }))
    await screen.findByRole('complementary', { name: 'Editing tools' })
    expect(job().status).toBe('editing')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('a.png')
    // Batch editing replaces the single-image actions.
    expect(screen.queryByTestId('new-image-input')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull()

    const slider = screen.getByRole('slider', { name: 'Edge softness' })
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: '72' } })
    fireEvent.pointerUp(slider)

    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }))
    await screen.findByRole('table', { name: 'Batch queue' })
    expect(rows().map((r) => r.textContent)).toEqual([
      'a.png640 × 480DoneEditedEdit',
      'corrupt.png—Failed Could not decode image',
      'c.png640 × 480DoneEdit',
    ])
    const item = job().items[0]
    expect(item.edited).toBe(true)
    expect(sessionStore.getState().editStates[item.editStateId!].edgeValue).toBe(72)
    expect(job().status).toBe('complete')
    expect(screen.getByText('2 done · 1 failed')).toBeTruthy()

    // Reopening keeps the saved edits.
    fireEvent.click(screen.getByRole('button', { name: 'Edit a.png' }))
    await screen.findByRole('complementary', { name: 'Editing tools' })
    expect((screen.getByRole('slider', { name: 'Edge softness' }) as HTMLInputElement).value).toBe('72')
  })

  it('editing is disabled while the ZIP is streaming', async () => {
    await processedQueue()
    act(() => zipStreaming.set(job().id, true))
    expect((screen.getByRole('button', { name: 'Edit a.png' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Editing is disabled while the ZIP is being written.')).toBeTruthy()
    act(() => zipStreaming.set(job().id, false))
    expect((screen.getByRole('button', { name: 'Edit a.png' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
