import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { sessionReset, sessionStore } from './domain'
import { loadModel, ModelLoadError, type ModelHandle } from './model/loader'

vi.mock('./model/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model/loader')>()),
  loadModel: vi.fn(),
}))

const MESSAGE = 'Could not load the background-removal model. Check your connection and retry.'

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })))
})
afterEach(() => {
  cleanup()
  sessionReset()
  vi.unstubAllGlobals()
  vi.mocked(loadModel).mockReset()
})

describe('tiny model load failure (NFR-17)', () => {
  it('shows the error panel with Retry, keeps upload working, and Retry reloads the model', async () => {
    vi.mocked(loadModel)
      .mockRejectedValueOnce(new ModelLoadError('tiny', 'fetch', 'offline'))
      .mockResolvedValueOnce({ tier: 'tiny' } as ModelHandle)

    render(<App />)
    expect(loadModel).toHaveBeenCalledWith('tiny', expect.any(Object))
    const panel = await screen.findByTestId('model-error')
    expect(panel.textContent).toContain(MESSAGE)

    // Ingestion is not blocked: an image can still be uploaded while the model is unavailable.
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'cat.png', { type: 'image/png' })] } })
    await screen.findByTestId('processing-view')
    expect(Object.values(sessionStore.getState().sourceImages)).toHaveLength(1)
    expect(screen.queryByText(/Preparing model/)).toBeNull() // no fake progress while blocked

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByTestId('model-error')).toBeNull())
    expect(loadModel).toHaveBeenCalledTimes(2)
  })
})
