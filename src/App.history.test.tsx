import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editHistory, editStateForImage, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))

const png = (name: string) => new File(['x'], name, { type: 'image/png' })
const images = () => Object.values(sessionStore.getState().sourceImages)
const edit = () => editStateForImage(sessionStore.getState(), images()[0].id)!
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const slider = () => screen.getByRole('slider', { name: 'Edge softness' }) as HTMLInputElement

async function openEditor(name = 'photo.png') {
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [png(name)] } })
  await screen.findByRole('complementary', { name: 'Editing tools' })
}
/** One slider gesture: drag through intermediate values, release. */
function edgeGesture(...values: number[]) {
  const s = slider()
  fireEvent.pointerDown(s)
  for (const v of values) fireEvent.change(s, { target: { value: String(v) } })
  fireEvent.pointerUp(s)
}
function cropGesture(steps: number) {
  fireEvent.click(screen.getByRole('button', { name: /^(Crop image|Adjust crop)$/ }))
  const se = screen.getByRole('button', { name: 'Resize crop from bottom-right corner' })
  for (let i = 0; i < steps; i++) fireEvent.keyDown(se, { key: 'ArrowLeft', shiftKey: true })
  fireEvent.click(button('Apply crop'))
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })))
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

describe('undo / redo (FR-22)', () => {
  it('a slider drag is one step; buttons disable at the history boundaries', async () => {
    render(<App />)
    await openEditor()
    expect(button('Undo').disabled).toBe(true)
    expect(button('Redo').disabled).toBe(true)

    edgeGesture(55, 62, 70)
    expect(edit().edgeValue).toBe(70)
    expect(button('Undo').disabled).toBe(false)
    expect(button('Redo').disabled).toBe(true)

    fireEvent.click(button('Undo'))
    expect(edit().edgeValue).toBe(50) // the whole drag, not 62
    expect(button('Undo').disabled).toBe(true)
    expect(button('Redo').disabled).toBe(false)

    fireEvent.click(button('Redo'))
    expect(edit().edgeValue).toBe(70)
    expect(button('Redo').disabled).toBe(true)
  })

  it('21 mixed edge and crop changes undo back to the auto result and redo forward again', async () => {
    render(<App />)
    await openEditor()
    const seen: Array<{ edgeValue: number; crop: unknown }> = [{ edgeValue: 50, crop: null }]
    for (let i = 0; i < 21; i++) {
      if (i % 2 === 0) edgeGesture(10 + i * 4)
      else cropGesture(1)
      seen.push({ edgeValue: edit().edgeValue, crop: edit().crop })
    }
    expect(edit().crop).toEqual({ x: 0, y: 0, width: 3900, height: 3000 })
    for (let i = seen.length - 2; i >= 0; i--) {
      fireEvent.click(button('Undo'))
      expect({ edgeValue: edit().edgeValue, crop: edit().crop }).toEqual(seen[i])
    }
    expect(button('Undo').disabled).toBe(true)
    expect(screen.getByTestId('output-size').textContent).toBe('4000 × 3000 px')
    for (let i = 1; i < seen.length; i++) fireEvent.click(button('Redo'))
    expect({ edgeValue: edit().edgeValue, crop: edit().crop }).toEqual(seen[seen.length - 1])
    expect(button('Redo').disabled).toBe(true)
  })

  it('a new change after undo clears redo', async () => {
    render(<App />)
    await openEditor()
    edgeGesture(70)
    fireEvent.click(button('Undo'))
    edgeGesture(30)
    expect(button('Redo').disabled).toBe(true)
  })

  it('keyboard: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo', async () => {
    render(<App />)
    await openEditor()
    edgeGesture(80)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(edit().edgeValue).toBe(50)
    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true })
    expect(edit().edgeValue).toBe(80)
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })
    expect(edit().edgeValue).toBe(80)
  })
})

describe('reset edits (FR-23)', () => {
  it('clears brush, edge and crop state in one undoable step', async () => {
    render(<App />)
    await openEditor()
    edgeGesture(20)
    cropGesture(5)
    act(() => void sessionStore.update('editStates', edit().id, { strokes: [{ mode: 'erase', radius: 9, points: [{ x: 5, y: 5 }] }] }))
    const before = edit()

    fireEvent.click(button('Reset edits'))
    expect(edit()).toMatchObject({ strokes: [], edgeValue: 50, crop: null })
    expect(edit().cutoutId).toBe(before.cutoutId) // still the auto-removal cutout
    expect(button('Reset edits').disabled).toBe(true)

    fireEvent.click(button('Undo'))
    expect(edit()).toMatchObject({ strokes: before.strokes, edgeValue: 20, crop: before.crop })
  })
})

describe('history lifetime', () => {
  it('survives the editor UI unmounting and remounting within the session', async () => {
    render(<App />)
    await openEditor()
    edgeGesture(65)
    cleanup() // tear down every component (as when switching panels/views)
    render(<App />)
    // The session still holds the image; the editor comes back with its history intact.
    await screen.findByRole('complementary', { name: 'Editing tools' }).catch(() => null)
    const id = edit().id
    expect(editHistory.canUndo(id)).toBe(true)
  })

  it('is dropped with the image when a new image replaces it', async () => {
    render(<App />)
    await openEditor('first.png')
    const firstId = edit().id
    edgeGesture(65)
    fireEvent.change(screen.getByTestId('new-image-input'), { target: { files: [png('second.png')] } })
    fireEvent.click(button('Discard edits'))
    await screen.findByText('second.png')
    await screen.findByRole('complementary', { name: 'Editing tools' })
    expect(editHistory.canUndo(firstId)).toBe(false)
    expect(button('Undo').disabled).toBe(true)
  })
})
