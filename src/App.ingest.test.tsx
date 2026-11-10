import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { sessionReset, sessionStore } from './domain'

// The model loader is exercised in src/model/*.test.ts; here it stays pending so the shell is in its normal loading state.
vi.mock('./model/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model/loader')>()),
  loadModel: vi.fn(() => new Promise(() => {})),
}))


const file = (name: string, type: string, body = 'ok') => new File([body], name, { type })
const images = () => Object.values(sessionStore.getState().sourceImages)

beforeEach(() => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (blob: Blob) => {
      if ((await blob.text()) === 'corrupt') throw new DOMException('bad', 'EncodingError')
      return { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap
    }),
  )
  URL.createObjectURL = vi.fn(() => 'blob:test')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  sessionReset()
  vi.unstubAllGlobals()
})

const pick = (files: File[]) => fireEvent.change(screen.getByTestId('upload-input'), { target: { files } })
const drop = (files: File[]) => fireEvent.drop(screen.getByTestId('upload-area'), { dataTransfer: { files } })

describe('single-image ingestion (FR-2)', () => {
  it('file picker selection creates a SourceImage and shows the processing state', async () => {
    render(<App />)
    pick([file('cat.png', 'image/png')])
    expect(await screen.findByTestId('processing-view')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Preparing model')
    expect(screen.getByText('800 × 600 px')).toBeTruthy()
    expect(images()).toHaveLength(1)
    expect(images()[0]).toMatchObject({ fileName: 'cat.png', decodePath: 'native', sourceKind: 'upload' })
  })

  it('dropping multiple files ingests only the first image', async () => {
    render(<App />)
    drop([file('readme.txt', 'text/plain'), file('first.jpg', 'image/jpeg'), file('second.png', 'image/png')])
    await screen.findByTestId('processing-view')
    expect(images().map((i) => i.fileName)).toEqual(['first.jpg'])
    expect(screen.getByRole('heading', { name: 'first.jpg' })).toBeTruthy()
  })

  it('cancelling the picker (empty selection) leaves the session unchanged', async () => {
    render(<App />)
    const before = sessionStore.getState()
    await act(async () => pick([]))
    expect(sessionStore.getState()).toBe(before)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('upload-input')).toBeTruthy()
  })

  it('native decode failure shows the file name and "Unsupported or corrupt image" and creates nothing', async () => {
    render(<App />)
    pick([file('broken.png', 'image/png', 'corrupt')])
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('broken.png: Unsupported or corrupt image.')
    expect(images()).toHaveLength(0)
    expect(screen.getByTestId('upload-input')).toBeTruthy()
  })

  it('Start over discards the image and returns to the empty state', async () => {
    render(<App />)
    pick([file('cat.png', 'image/png')])
    await screen.findByTestId('processing-view')
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }))
    await waitFor(() => expect(images()).toHaveLength(0))
    expect(screen.getByTestId('upload-input')).toBeTruthy()
  })
})
