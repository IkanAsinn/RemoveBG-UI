import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createCutoutResult, editHistory, sessionReset, sessionStore, type SourceImage } from './domain'
import { loadModel, type ModelHandle } from './model/loader'
import { removeBackground } from './matte/remove'
import { EncodeError, encodeCanvas, renderOutput } from './composite/output'

vi.mock('./model/loader', async (orig) => ({ ...(await orig<typeof import('./model/loader')>()), loadModel: vi.fn() }))
vi.mock('./matte/remove', async (orig) => ({ ...(await orig<typeof import('./matte/remove')>()), removeBackground: vi.fn() }))
vi.mock('./export/encode', async (orig) => ({
  ...(await orig<typeof import('./export/encode')>()),
  detectFormatSupport: vi.fn(async () => ({ png: true, webp: true, jxl: false })),
}))
vi.mock('./composite/output', async (orig) => ({
  ...(await orig<typeof import('./composite/output')>()),
  renderOutput: vi.fn(() => ({ width: 640, height: 480 })),
  encodeCanvas: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) }
const picker = vi.fn()

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() })))
  vi.stubGlobal('showSaveFilePicker', picker)
  picker.mockReset().mockResolvedValue({ createWritable: async () => writable })
  writable.write.mockClear()
  vi.mocked(loadModel).mockResolvedValue({ tier: 'tiny', backend: 'wasm' } as ModelHandle)
  vi.mocked(removeBackground).mockImplementation(async (_h, img: SourceImage) =>
    createCutoutResult({ sourceImageId: img.id, modelTier: 'tiny', cutoutBitmap: { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap, alphaMask: new Uint8ClampedArray(4), status: 'ready' }),
  )
})
afterEach(() => {
  cleanup()
  sessionReset()
  editHistory.clear()
  vi.unstubAllGlobals()
  vi.mocked(renderOutput).mockClear()
  vi.mocked(encodeCanvas).mockClear()
})

async function openEditor() {
  render(<App />)
  fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'cat photo.jpg', { type: 'image/jpeg' })] } })
  await screen.findByRole('complementary', { name: 'Editing tools' })
  return within(screen.getByTestId('export-panel'))
}

describe('Export panel (FR-30, FR-31, FR-33…FR-36)', () => {
  it('PNG is selected by default, shows the full output size and has no downscale control', async () => {
    const panel = await openEditor()
    expect((panel.getByRole('radio', { name: 'PNG' }) as HTMLInputElement).checked).toBe(true)
    expect(panel.getByTestId('output-size').textContent).toBe('640 × 480 px')
    expect(panel.queryByRole('slider')).toBeNull()
    expect(panel.queryByRole('spinbutton')).toBeNull()
  })

  it('Download renders the composite, encodes PNG and saves {basename}-nobg.png', async () => {
    const panel = await openEditor()
    fireEvent.click(panel.getByRole('button', { name: 'Download PNG' }))
    expect((await panel.findByTestId('export-result')).textContent).toBe('Saved cat photo-nobg.png (640 × 480 px).')
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'cat photo-nobg.png' }))
    expect(renderOutput).toHaveBeenCalledWith(expect.objectContaining({ width: 640, height: 480, background: sessionStore.getState().background }))
    expect(encodeCanvas).toHaveBeenCalledWith(expect.anything(), 'image/png', undefined)
    expect(writable.write).toHaveBeenCalledOnce()
  })

  it('canceling the save keeps the edits and writes nothing', async () => {
    const panel = await openEditor()
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '70' } })
    picker.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    fireEvent.click(panel.getByRole('button', { name: 'Download PNG' }))
    expect((await panel.findByTestId('export-result')).textContent).toBe('Save canceled. Nothing was written.')
    expect(renderOutput).not.toHaveBeenCalled()
    expect(writable.write).not.toHaveBeenCalled()
    expect((screen.getByRole('slider', { name: 'Edge softness' }) as HTMLInputElement).value).toBe('70')
  })

  it('an encode failure shows an error and keeps the session, background and format', async () => {
    const panel = await openEditor()
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Solid color' }))
    vi.mocked(encodeCanvas).mockRejectedValueOnce(new EncodeError())
    fireEvent.click(panel.getByRole('button', { name: 'Download PNG' }))
    expect((await panel.findByRole('alert')).textContent).toBe('Could not encode the image as PNG. Your edits and background are unchanged.')
    expect(writable.write).not.toHaveBeenCalled()
    expect((panel.getByRole('radio', { name: 'PNG' }) as HTMLInputElement).checked).toBe(true)
    expect(sessionStore.getState().background.type).toBe('solid')
    expect((screen.getByRole('slider', { name: 'Edge softness' }) as HTMLInputElement).value).toBe('30')
  })

  it('a canvas over the browser limit shows the too-large error', async () => {
    const panel = await openEditor()
    vi.mocked(renderOutput).mockImplementationOnce(() => {
      throw new RangeError('canvas too large')
    })
    fireEvent.click(panel.getByRole('button', { name: 'Download PNG' }))
    expect((await panel.findByRole('alert')).textContent).toBe('This image is too large to export on this browser.')
    expect(writable.write).not.toHaveBeenCalled()
  })
})

describe('WebP and JXL (FR-30, FR-32, FR-37, OQ-6)', () => {
  it('JXL without native encoding is shown disabled with the reason; no JXL file can be requested', async () => {
    const panel = await openEditor()
    const jxl = (await panel.findByRole('radio', { name: 'JXL' })) as HTMLInputElement
    await vi.waitFor(() => expect(jxl.disabled).toBe(true))
    expect(panel.getByTestId('export-unsupported').textContent).toBe("JXL export isn't supported by this browser.")
    expect(jxl.getAttribute('aria-describedby')).toBe('export-unsupported')
    fireEvent.click(jxl)
    expect((panel.getByRole('radio', { name: 'PNG' }) as HTMLInputElement).checked).toBe(true)
  })

  it('WebP downloads {basename}-nobg.webp, encoded lossless', async () => {
    const panel = await openEditor()
    const webp = panel.getByRole('radio', { name: 'WebP' }) as HTMLInputElement
    await vi.waitFor(() => expect(webp.disabled).toBe(false))
    fireEvent.click(webp)
    vi.mocked(encodeCanvas).mockResolvedValueOnce(new Blob(['webp'], { type: 'image/webp' }))
    fireEvent.click(panel.getByRole('button', { name: 'Download WebP' }))
    expect((await panel.findByTestId('export-result')).textContent).toBe('Saved cat photo-nobg.webp (640 × 480 px).')
    expect(encodeCanvas).toHaveBeenCalledWith(expect.anything(), 'image/webp', 1)
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'cat photo-nobg.webp', types: [{ description: 'WebP image', accept: { 'image/webp': ['.webp'] } }] })
  })

  it('a WebP encoder failure keeps WebP selected and the edits; it never falls back to PNG', async () => {
    const panel = await openEditor()
    const webp = panel.getByRole('radio', { name: 'WebP' }) as HTMLInputElement
    await vi.waitFor(() => expect(webp.disabled).toBe(false))
    fireEvent.click(webp)
    fireEvent.change(screen.getByRole('slider', { name: 'Edge softness' }), { target: { value: '65' } })
    vi.mocked(encodeCanvas).mockRejectedValueOnce(new EncodeError())
    fireEvent.click(panel.getByRole('button', { name: 'Download WebP' }))
    expect((await panel.findByRole('alert')).textContent).toBe('Could not encode the image as WebP. Your edits and background are unchanged.')
    expect(encodeCanvas).toHaveBeenCalledTimes(1)
    expect(writable.write).not.toHaveBeenCalled()
    expect(webp.checked).toBe(true)
    expect((screen.getByRole('slider', { name: 'Edge softness' }) as HTMLInputElement).value).toBe('65')
  })
})
