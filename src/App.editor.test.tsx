import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editStateForImage, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))

const png = (name: string) => new File(['x'], name, { type: 'image/png' })
const view = () => screen.getByTestId('processing-view')
const current = () => Object.values(sessionStore.getState().sourceImages)
const edit = () => editStateForImage(sessionStore.getState(), current()[0].id)!

async function openEditor(name = 'first.png') {
  render(<App />)
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [png(name)] } })
  await screen.findByRole('complementary', { name: 'Editing tools' })
}
const makeAnEdit = () => fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '70' } })

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
  vi.unstubAllGlobals()
})

describe('editor shell (T-010)', () => {
  it('a ready cutout opens the editor with the image visible and undo/redo disabled', async () => {
    await openEditor()
    expect(screen.getByTestId('source-preview').getAttribute('aria-label')).toBe('Background removed: first.png')
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reset edits' }) as HTMLButtonElement).disabled).toBe(true)
    // Brush controls, edge slider, crop entry point, background and export panels are all present.
    expect(screen.getByRole('radio', { name: 'Erase' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Restore' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Brush size' })).toBeTruthy()
    expect((screen.getByRole('slider', { name: 'Edge softness' }) as HTMLInputElement).value).toBe('50')
    expect(screen.getByRole('button', { name: 'Crop image' })).toBeTruthy()
    expect(screen.getByTestId('background-panel')).toBeTruthy()
    expect(screen.getByTestId('export-panel')).toBeTruthy()
    expect(screen.getByTestId('output-size').textContent).toBe('4000 × 3000 px')
    expect(edit()).toMatchObject({ strokes: [], edgeValue: 50, crop: null, brushMode: 'erase' })
  })

  it('output dimensions follow the crop rectangle', async () => {
    await openEditor()
    act(() => sessionStore.update('editStates', edit().id, { crop: { x: 100, y: 50, width: 1200, height: 900 } }))
    expect(screen.getByTestId('output-size').textContent).toBe('1200 × 900 px')
    act(() => sessionStore.update('editStates', edit().id, { crop: null }))
    expect(screen.getByTestId('output-size').textContent).toBe('4000 × 3000 px')
  })

  it('Reset edits restores the auto-removal state', async () => {
    await openEditor()
    makeAnEdit()
    const reset = screen.getByRole('button', { name: 'Reset edits' }) as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    fireEvent.click(reset)
    expect(edit().edgeValue).toBe(50)
    expect(reset.disabled).toBe(true)
  })
})

describe('discard confirmation (FR-9)', () => {
  it('a new image without edits replaces the current one directly', async () => {
    await openEditor()
    fireEvent.change(screen.getByTestId('new-image-input'), { target: { files: [png('second.png')] } })
    await waitFor(() => expect(current().map((i) => i.fileName)).toEqual(['second.png']))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a new image with edits asks first; Cancel keeps the image and edits intact', async () => {
    await openEditor()
    makeAnEdit()
    const before = { image: current()[0], edit: edit() }

    fireEvent.change(screen.getByTestId('new-image-input'), { target: { files: [png('second.png')] } })
    const dialog = screen.getByRole('alertdialog', { name: 'Discard your edits?' })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })) // safe default

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(current()).toEqual([before.image])
    expect(edit()).toBe(before.edit)
    expect(view().querySelector('h1')!.textContent).toBe('first.png')
  })

  it('confirming discards the edits and opens the new image', async () => {
    await openEditor()
    makeAnEdit()
    const files = [png('second.png')]
    fireEvent.change(screen.getByTestId('new-image-input'), { target: { files } })
    files.length = 0 // browsers empty the live FileList when the input is cleared, before the user confirms
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }))
    await waitFor(() => expect(current().map((i) => i.fileName)).toEqual(['second.png']))
    await screen.findByRole('complementary', { name: 'Editing tools' })
    expect(edit().edgeValue).toBe(50) // fresh EditState for the new image
    expect(Object.values(sessionStore.getState().editStates)).toHaveLength(1)
  })

  it('Escape cancels, and Start over / paste with edits also ask first', async () => {
    await openEditor()
    makeAnEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(current()).toHaveLength(1)

    const pasted = png('image.png')
    fireEvent.paste(document, { clipboardData: { files: [pasted], items: [] } })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(current()[0].fileName).toBe('first.png')
  })
})
