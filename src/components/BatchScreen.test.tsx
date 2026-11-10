import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCutoutResult, sessionReset } from '../domain'
import type { ModelHandle } from '../model/loader'
import type { BatchDeps } from '../batch/process'
import type { ZipSink } from '../zip/stream'
import { BatchScreen } from './BatchScreen'

const tiny = { tier: 'tiny', backend: 'wasm' } as ModelHandle

function deps(over: Partial<BatchDeps> = {}): () => BatchDeps {
  return () => ({
    yieldToUi: async () => {},
    loadTiny: async () => tiny,
    decode: async (file) => {
      if (file.name.startsWith('corrupt')) throw new Error('bad')
      return {
        fileName: file.name,
        mimeType: 'image/png',
        byteSize: file.size,
        width: 640,
        height: 480,
        sourceKind: 'batch',
        originalBlob: file,
        decodedBitmap: { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap,
        decodePath: 'native',
      }
    },
    remove: async (handle, image) =>
      createCutoutResult({
        sourceImageId: image.id,
        modelTier: handle.tier,
        cutoutBitmap: { close: vi.fn() } as unknown as ImageBitmap,
        alphaMask: new Uint8ClampedArray(1),
        status: 'ready',
      }),
    encode: async () => new Blob(['png'], { type: 'image/png' }),
    ...over,
  })
}

const choose = (...names: string[]) =>
  fireEvent.change(screen.getByTestId('batch-input'), { target: { files: names.map((n) => new File(['x'], n, { type: 'image/png' })) } })
const rows = () => within(screen.getByRole('table', { name: 'Batch queue' })).getAllByRole('row').slice(1)

afterEach(() => {
  cleanup()
  sessionReset()
})

describe('BatchScreen processing (FR-41, FR-42, FR-45, FR-46, NFR-17)', () => {
  it('processes the queue and shows dimensions, Done/Failed rows and the failed list', async () => {
    render(<BatchScreen onBack={() => {}} deps={deps()} />)
    choose('a.png', 'corrupt.png', 'c.png')
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    expect(await screen.findByText('2 done · 1 failed')).toBeTruthy()
    expect(rows().map((r) => r.textContent)).toEqual([
      'a.png640 × 480Done',
      'corrupt.png—Failed Could not decode image',
      'c.png640 × 480Done',
    ])
    const failures = screen.getByTestId('batch-failures')
    expect(failures.textContent).toContain('corrupt.png: Could not decode image')
    expect(screen.queryByRole('button', { name: 'Start batch' })).toBeNull()
  })

  it('all items failing shows an error summary listing each file and says no ZIP was created', async () => {
    render(<BatchScreen onBack={() => {}} deps={deps()} />)
    choose('corrupt-a.png', 'corrupt-b.png')
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    const summary = await screen.findByTestId('batch-error-summary')
    expect(summary.getAttribute('role')).toBe('alert')
    expect(summary.textContent).toContain('no ZIP was created')
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'corrupt-a.png: Could not decode image',
      'corrupt-b.png: Could not decode image',
    ])
  })

  it('does not start without the required model and offers a retry', async () => {
    let online = false
    render(<BatchScreen onBack={() => {}} deps={deps({ loadTiny: async () => (online ? tiny : Promise.reject(new Error('offline'))) })} />)
    choose('a.png')
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not load the background-removal model. Check your connection and retry.',
    )
    expect(rows()[0].textContent).toContain('Queued')
    online = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('1 done · 0 failed')).toBeTruthy()
  })
})

describe('Download ZIP (FR-44, FR-48, FR-49)', () => {
  const zipButton = () => screen.getByRole('button', { name: /Download ZIP|Writing ZIP/ }) as HTMLButtonElement
  const memorySink = (fail = false): ZipSink => ({
    write: async () => {
      if (fail) throw new Error('disk full')
    },
    close: async () => {},
    abort: async () => {},
  })

  it('is disabled until at least one item is Done', async () => {
    render(<BatchScreen onBack={() => {}} deps={deps()} zipDeps={{ openSink: async () => memorySink() }} />)
    choose('a.png', 'corrupt.png')
    expect(zipButton().disabled).toBe(true) // queued
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    await screen.findByText('1 done · 1 failed')
    expect(zipButton().disabled).toBe(false)
    fireEvent.click(zipButton())
    expect((await screen.findByText(/ZIP saved with 1 image./)).textContent).toContain('Failed images are not included')
  })

  it('is not offered when every item failed', async () => {
    render(<BatchScreen onBack={() => {}} deps={deps()} />)
    choose('corrupt-a.png')
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    await screen.findByTestId('batch-error-summary')
    expect(screen.queryByRole('button', { name: 'Download ZIP' })).toBeNull()
  })

  it('canceling the save keeps the batch; a failed write shows the incomplete-ZIP error', async () => {
    let next: ZipSink | null = null
    render(<BatchScreen onBack={() => {}} deps={deps()} zipDeps={{ openSink: async () => next }} />)
    choose('a.png')
    fireEvent.click(screen.getByRole('button', { name: 'Start batch' }))
    await screen.findByText('1 done · 0 failed')

    fireEvent.click(zipButton())
    expect(await screen.findByText('Save canceled. No ZIP was written; the batch is still here.')).toBeTruthy()
    expect(rows()[0].textContent).toContain('Done')

    next = memorySink(true)
    fireEvent.click(zipButton())
    expect((await screen.findByRole('alert')).textContent).toBe('ZIP download was incomplete')
    expect(screen.queryByText(/ZIP saved/)).toBeNull()
    expect(zipButton().disabled).toBe(false) // editing/zipping lock released after the failure
  })
})
