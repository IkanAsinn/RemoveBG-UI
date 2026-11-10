import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { sessionReset, sessionStore } from './domain'

// The model loader is exercised in src/model/*.test.ts; here it stays pending so the shell is in its normal loading state.
vi.mock('./model/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model/loader')>()),
  loadModel: vi.fn(() => new Promise(() => {})),
}))


const images = () => Object.values(sessionStore.getState().sourceImages)
const png = () => new File(['ok'], 'image.png', { type: 'image/png' })
const notice = () => screen.getByTestId('notice').textContent

/** Minimal DataTransfer-shaped object for paste events. */
const clipboardData = (files: File[], strings: string[] = []) => ({
  files,
  items: [
    ...files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    ...strings.map(() => ({ kind: 'string', type: 'text/plain', getAsFile: () => null })),
  ],
})

const stubClipboard = (clipboard: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() })))
  URL.createObjectURL = vi.fn(() => 'blob:test')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  sessionReset()
  vi.unstubAllGlobals()
  stubClipboard(undefined)
  document.body.innerHTML = ''
})

describe('paste shortcut (FR-3)', () => {
  it('ingests a pasted image as sourceKind "clipboard"', async () => {
    render(<App />)
    fireEvent.paste(document, { clipboardData: clipboardData([png()]) })
    await screen.findByTestId('processing-view')
    expect(images()).toHaveLength(1)
    expect(images()[0]).toMatchObject({ sourceKind: 'clipboard', fileName: 'pasted-image.png', decodePath: 'native' })
  })

  it('ignores paste events that originate inside text inputs and textareas', async () => {
    render(<App />)
    const input = document.body.appendChild(document.createElement('input'))
    const area = document.body.appendChild(document.createElement('textarea'))
    await act(async () => {
      fireEvent.paste(input, { clipboardData: clipboardData([png()]) })
      fireEvent.paste(area, { clipboardData: clipboardData([png()]) })
    })
    expect(images()).toHaveLength(0)
    expect(notice()).toBe('')
    expect(screen.queryByTestId('processing-view')).toBeNull()
  })

  it('shows the non-blocking no-image message when the paste has no image, and upload stays usable', async () => {
    render(<App />)
    await act(async () => fireEvent.paste(document, { clipboardData: clipboardData([], ['hello']) }))
    expect(notice()).toBe('No image found on the clipboard.')
    expect(screen.queryByRole('alert')).toBeNull()
    const upload = screen.getByTestId('upload-input') as HTMLInputElement
    expect(upload.disabled).toBe(false)
    fireEvent.change(upload, { target: { files: [png()] } })
    await screen.findByTestId('processing-view')
  })
})

describe('Paste button (FR-3, FR-4, OQ-7)', () => {
  const clickPaste = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Paste' })))

  it('ingests an image from the async Clipboard API', async () => {
    const blob = new Blob(['ok'], { type: 'image/png' })
    stubClipboard({ read: vi.fn(async () => [{ types: ['text/html', 'image/png'], getType: async () => blob }]) })
    render(<App />)
    await clickPaste()
    await screen.findByTestId('processing-view')
    expect(images()[0]).toMatchObject({ sourceKind: 'clipboard', originalBlob: blob })
  })

  it('shows the no-image message when the clipboard holds only text', async () => {
    stubClipboard({ read: vi.fn(async () => [{ types: ['text/plain'], getType: vi.fn() }]) })
    render(<App />)
    await clickPaste()
    expect(notice()).toBe('No image found on the clipboard.')
  })

  it.each([
    ['permission denied', { read: vi.fn(async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))) }],
    ['API unsupported', { writeText: vi.fn() }],
    ['no clipboard object', undefined],
  ])('%s → fallback message, upload not blocked', async (_label, clipboard) => {
    stubClipboard(clipboard)
    render(<App />)
    await clickPaste()
    expect(notice()).toBe('Clipboard image paste is not available in this browser. Use upload instead.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByTestId('upload-input') as HTMLInputElement).disabled).toBe(false)
    expect(images()).toHaveLength(0)
  })
})
