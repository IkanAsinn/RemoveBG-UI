import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editStateForImage, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))

const png = (name: string) => new File(['x'], name, { type: 'image/png' })
const edit = () => editStateForImage(sessionStore.getState(), Object.values(sessionStore.getState().sourceImages)[0].id)!
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const press = (name: string, key: string, times = 1, shiftKey = true) => {
  const el = screen.getByRole('button', { name })
  for (let i = 0; i < times; i++) fireEvent.keyDown(el, { key, shiftKey })
}
const SE = 'Resize crop from bottom-right corner'
const E = 'Resize crop from right edge'

let size = { width: 4000, height: 3000 }
async function openEditor() {
  render(<App />)
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [png('photo.png')] } })
  await screen.findByRole('complementary', { name: 'Editing tools' })
}

beforeEach(() => {
  size = { width: 4000, height: 3000 }
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ ...size, close: vi.fn() })))
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

describe('crop tool (FR-20, FR-21)', () => {
  it('opens on the whole image, resizes with handles, and Apply sets the output size', async () => {
    await openEditor()
    fireEvent.click(button('Crop image'))
    expect(screen.getByTestId('crop-overlay')).toBeTruthy()
    expect(screen.getByTestId('crop-size').textContent).toBe('4000 × 3000 px')
    expect(screen.getAllByRole('button', { name: /^Resize crop/ })).toHaveLength(8)

    press(SE, 'ArrowLeft', 100) // Shift+Arrow = 10 px
    press(SE, 'ArrowUp', 50)
    expect(screen.getByTestId('crop-size').textContent).toBe('3000 × 2500 px')
    expect(edit().crop).toBeNull() // nothing is committed until Apply
    expect(screen.getByTestId('output-size').textContent).toBe('4000 × 3000 px')

    fireEvent.click(button('Apply crop'))
    expect(screen.queryByTestId('crop-overlay')).toBeNull()
    expect(edit().crop).toEqual({ x: 0, y: 0, width: 3000, height: 2500 })
    expect(screen.getByTestId('output-size').textContent).toBe('3000 × 2500 px')
    expect(button('Reset edits').disabled).toBe(false)
  })

  it('moving the body is limited to the image bounds', async () => {
    await openEditor()
    fireEvent.click(button('Crop image'))
    press(SE, 'ArrowLeft', 200) // 2000 wide
    const body = screen.getByTestId('crop-rect')
    for (let i = 0; i < 500; i++) fireEvent.keyDown(body, { key: 'ArrowRight', shiftKey: true })
    expect(body.getAttribute('aria-label')).toContain('2000 × 3000 px at 2000, 0')
  }, 15_000) // hundreds of synchronous key events; slow under a fully parallel run

  it('Cancel restores the previous crop', async () => {
    await openEditor()
    fireEvent.click(button('Crop image'))
    press(SE, 'ArrowLeft', 100)
    fireEvent.click(button('Apply crop'))
    const applied = edit().crop

    fireEvent.click(button('Adjust crop'))
    expect(screen.getByTestId('crop-size').textContent).toBe('3000 × 3000 px') // starts from the applied crop
    press(SE, 'ArrowUp', 100)
    fireEvent.click(button('Cancel'))
    expect(edit().crop).toEqual(applied)
    expect(screen.getByTestId('output-size').textContent).toBe('3000 × 3000 px')

    // Escape on a handle cancels too; Enter applies.
    fireEvent.click(button('Adjust crop'))
    press(E, 'ArrowLeft', 10)
    fireEvent.keyDown(screen.getByRole('button', { name: E }), { key: 'Escape' })
    expect(edit().crop).toEqual(applied)
    fireEvent.click(button('Adjust crop'))
    press(E, 'ArrowLeft', 10)
    fireEvent.keyDown(screen.getByRole('button', { name: E }), { key: 'Enter' })
    expect(edit().crop).toEqual({ x: 0, y: 0, width: 2900, height: 3000 })
  })

  it('dragging to zero stops at 16 × 16, and Full image removes the crop', async () => {
    await openEditor()
    fireEvent.click(button('Crop image'))
    press(SE, 'ArrowLeft', 1000)
    press(SE, 'ArrowUp', 1000)
    expect(screen.getByTestId('crop-size').textContent).toBe('16 × 16 px')
    expect(button('Apply crop').disabled).toBe(false)
    fireEvent.click(button('Apply crop'))
    expect(screen.getByTestId('output-size').textContent).toBe('16 × 16 px')

    fireEvent.click(button('Adjust crop'))
    fireEvent.click(button('Full image'))
    fireEvent.click(button('Apply crop'))
    expect(edit().crop).toBeNull()
    expect(screen.getByTestId('output-size').textContent).toBe('4000 × 3000 px')
  }, 15_000)

  it('Apply is disabled when the crop is below the minimum (image narrower than 16 px)', async () => {
    size = { width: 10, height: 40 }
    await openEditor()
    fireEvent.click(button('Crop image'))
    expect(screen.getByTestId('crop-size').textContent).toBe('10 × 40 px')
    expect(button('Apply crop').disabled).toBe(true)
    expect(screen.getByTestId('crop-min').textContent).toContain('16 × 16')
  })

  it('Reset edits clears the crop', async () => {
    await openEditor()
    fireEvent.click(button('Crop image'))
    press(SE, 'ArrowLeft', 10)
    fireEvent.click(button('Apply crop'))
    fireEvent.click(button('Reset edits'))
    expect(edit().crop).toBeNull()
    expect(screen.getByTestId('output-size').textContent).toBe('4000 × 3000 px')
  })
})
