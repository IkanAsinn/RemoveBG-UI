import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))

const png = (name: string) => new File(['x'], name, { type: 'image/png' })

const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement
const bg = () => sessionStore.getState().background

async function openEditor() {
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [png('photo.png')] } })
  await screen.findByRole('complementary', { name: 'Editing tools' })
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
  vi.unstubAllGlobals()
})

describe('background panel (FR-24, FR-25, FR-29)', () => {
  it('shows five mutually exclusive choices with Transparent selected by default', async () => {
    render(<App />)
    await openEditor()
    const group = screen.getByRole('radiogroup', { name: 'Background' })
    const names = Array.from(group.querySelectorAll('input[type=radio]')).map((r) => r.closest('label')!.textContent)
    expect(names).toEqual(['Transparent', 'Solid color', 'Own image', 'Gradient', 'Templates'])
    expect(radio('Transparent').checked).toBe(true)
    expect(bg().type).toBe('transparent')
    expect(screen.queryByTestId('solid-controls')).toBeNull()

    fireEvent.click(radio('Solid color'))
    expect(Array.from(group.querySelectorAll('input')).filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1)
    expect(radio('Solid color').checked).toBe(true)
  })

  it('the colour picker and hex field set the same colour', async () => {
    render(<App />)
    await openEditor()
    fireEvent.click(radio('Solid color'))
    expect(bg()).toMatchObject({ type: 'solid', color: '#ffffff' })
    const picker = screen.getByLabelText('Background color') as HTMLInputElement
    const hex = screen.getByRole('textbox', { name: 'Hex color' }) as HTMLInputElement

    fireEvent.change(picker, { target: { value: '#e8433a' } })
    expect(bg().color).toBe('#e8433a')
    expect(hex.value).toBe('#e8433a')

    fireEvent.change(hex, { target: { value: '1F5' } })
    expect(bg().color).toBe('#11ff55')
    expect(picker.value).toBe('#11ff55')

    fireEvent.click(screen.getByRole('button', { name: '#000000' }))
    expect(bg().color).toBe('#000000')
    expect(hex.value).toBe('#000000')
  })

  it('an invalid hex shows an error and keeps the last valid colour', async () => {
    render(<App />)
    await openEditor()
    fireEvent.click(radio('Solid color'))
    const hex = screen.getByRole('textbox', { name: 'Hex color' }) as HTMLInputElement
    fireEvent.change(hex, { target: { value: '#12xz' } })
    expect(hex.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toMatch(/hex color/)
    expect(bg().color).toBe('#ffffff')
    fireEvent.blur(hex)
    expect(hex.value).toBe('#ffffff')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('switching back to Transparent removes the layer and returning to Solid restores the colour', async () => {
    render(<App />)
    await openEditor()
    fireEvent.click(radio('Solid color'))
    fireEvent.change(screen.getByLabelText('Background color'), { target: { value: '#2bb673' } })
    fireEvent.click(radio('Transparent'))
    expect(bg().type).toBe('transparent')
    expect(screen.queryByTestId('solid-controls')).toBeNull()
    fireEvent.click(radio('Solid color'))
    expect(bg()).toMatchObject({ type: 'solid', color: '#2bb673' })
  })
})

describe('own image and gradient backgrounds (FR-26, FR-27)', () => {
  const upload = (file: File) => fireEvent.change(screen.getByTestId('background-image-input'), { target: { files: [file] } })

  it('a valid upload becomes the image background; a failed decode shows the error and keeps it', async () => {
    render(<App />)
    await openEditor()
    fireEvent.click(radio('Own image'))
    expect(screen.getByRole('button', { name: 'Upload image' })).toBeTruthy()
    upload(new File(['x'], 'beach.jpg', { type: 'image/jpeg' }))
    await screen.findByRole('button', { name: 'Replace image' })
    const good = bg().imageBitmap
    expect(bg()).toMatchObject({ type: 'image' })
    expect(good).toMatchObject({ width: 4000, height: 3000 })
    expect(bg().imageBlob).toBeInstanceOf(File)

    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode'))
    upload(new File(['bad'], 'broken.png', { type: 'image/png' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Background image could not be decoded')
    expect(bg().imageBitmap).toBe(good)
    expect(bg().type).toBe('image')
  })

  it('a failed first upload leaves the previous (solid) background unchanged', async () => {
    render(<App />)
    await openEditor()
    fireEvent.click(radio('Solid color'))
    fireEvent.change(screen.getByLabelText('Background color'), { target: { value: '#123456' } })
    const before = bg()
    fireEvent.click(radio('Own image'))
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode'))
    upload(new File(['bad'], 'broken.png', { type: 'image/png' }))
    await screen.findByRole('alert')
    expect(bg().imageBitmap).toBeNull()
    expect(bg().color).toBe(before.color)
    expect(bg().type).toBe('solid') // the solid colour is still what is drawn
    expect((radio('Solid color') as HTMLInputElement).checked).toBe(true)
  })

  it('gradient mode offers the bundled gradients and selecting one updates the selection', async () => {
    render(<App />)
    await openEditor()
    fireEvent.click(radio('Gradient'))
    const group = screen.getByRole('group', { name: 'Gradients' })
    expect(group.querySelectorAll('button')).toHaveLength(8)
    expect(bg()).toMatchObject({ type: 'gradient', gradientId: 'sunset' })
    fireEvent.click(screen.getByRole('button', { name: 'Ocean' }))
    expect(bg()).toMatchObject({ type: 'gradient', gradientId: 'ocean' })
    expect(screen.getByRole('button', { name: 'Ocean' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(radio('Transparent'))
    fireEvent.click(radio('Gradient'))
    expect(bg().gradientId).toBe('ocean') // remembered
  })
})
