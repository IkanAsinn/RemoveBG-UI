import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionStore, createSourceImage } from '../domain'
import { openZipSink, zipSaveMethod, ZipSaveCanceledError } from '../zip/save'
import type { ZipSink } from '../zip/stream'
import { downloadBatchZip } from './download'
import { createBatch, setBatchOutput, zipStreaming } from './queue'

const store = createSessionStore()
afterEach(() => {
  store.reset()
  vi.unstubAllGlobals()
})

/** Batch with one Done item (a.png) and one Failed item. */
function batch() {
  const files = ['a.png', 'b.png'].map((n) => new File(['x'], n, { type: 'image/png' }))
  const job = createBatch(files, 2, store)
  store.update('batchJobs', job.id, {
    status: 'complete',
    items: job.items.map((i, n) => ({ ...i, status: n === 0 ? 'done' : 'failed', errorCode: n === 0 ? null : 'decode' })),
  })
  store.create('sourceImages', createSourceImage({
    id: job.items[0].sourceImageId, fileName: 'a.png', mimeType: 'image/png', byteSize: 1, width: 1, height: 1,
    sourceKind: 'batch', originalBlob: files[0], decodedBitmap: {} as ImageBitmap, decodePath: 'native',
  }))
  setBatchOutput(job.items[0].id, new Blob(['png-bytes']))
  return job.id
}

function sink(fail = false) {
  const seen = { streamingDuringWrite: [] as boolean[], bytes: 0 }
  const s: ZipSink & { [k: string]: ReturnType<typeof vi.fn> } = {
    write: vi.fn(async (c: Uint8Array) => {
      seen.streamingDuringWrite.push(zipStreaming.has(jobIdRef.current))
      if (fail) throw new Error('disk full')
      seen.bytes += c.length
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  }
  return { s, seen }
}
const jobIdRef = { current: '' }

describe('downloadBatchZip (FR-44, FR-48, FR-49)', () => {
  it('streams the Done items, locks editing during the write, then unlocks', async () => {
    const jobId = (jobIdRef.current = batch())
    const { s, seen } = sink()
    const outcome = await downloadBatchZip(jobId, { store, openSink: async () => s })
    expect(outcome).toEqual({ kind: 'saved', entries: 1 })
    expect(seen.streamingDuringWrite.every(Boolean)).toBe(true)
    expect(zipStreaming.has(jobId)).toBe(false)
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('a canceled save writes nothing and leaves the batch as it was', async () => {
    const jobId = batch()
    const before = store.getState().batchJobs[jobId]
    expect(await downloadBatchZip(jobId, { store, openSink: async () => null })).toEqual({ kind: 'canceled' })
    expect(store.getState().batchJobs[jobId]).toBe(before)
    expect(zipStreaming.has(jobId)).toBe(false)
  })

  it('a mid-stream failure reports an incomplete ZIP, aborts the sink and re-enables editing', async () => {
    const jobId = (jobIdRef.current = batch())
    const { s } = sink(true)
    expect(await downloadBatchZip(jobId, { store, openSink: async () => s })).toEqual({ kind: 'incomplete' })
    expect(s.abort).toHaveBeenCalledOnce()
    expect(s.close).not.toHaveBeenCalled()
    expect(zipStreaming.has(jobId)).toBe(false)
  })

  it('a download canceled in the browser mid-stream is reported as canceled, not saved', async () => {
    const jobId = batch()
    const s = { write: vi.fn(async () => Promise.reject(new ZipSaveCanceledError())), close: vi.fn(), abort: vi.fn(async () => {}) }
    expect(await downloadBatchZip(jobId, { store, openSink: async () => s as unknown as ZipSink })).toEqual({ kind: 'canceled' })
  })

  it('no streaming destination at all is reported as unsupported', async () => {
    const jobId = batch()
    expect(await downloadBatchZip(jobId, { store, openSink: () => Promise.reject(new Error('no')) })).toEqual({ kind: 'unsupported' })
  })

  it('refuses when nothing is Done', async () => {
    const job = createBatch([new File(['x'], 'q.png', { type: 'image/png' })], 1, store)
    await expect(downloadBatchZip(job.id, { store, openSink: async () => null })).rejects.toThrow('No completed images')
  })
})

describe('save destination (OQ-8, OQ-9)', () => {
  it('prefers the File System Access API and streams into the chosen file', async () => {
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
    const picker = vi.fn(async () => ({ createWritable: async () => writable }))
    vi.stubGlobal('showSaveFilePicker', picker)
    expect(zipSaveMethod()).toBe('file-system')
    const s = (await openZipSink('nobg-images.zip'))!
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'nobg-images.zip' }))
    await s.write(new Uint8Array([1]))
    await s.abort('x')
    expect(writable.write).toHaveBeenCalledOnce()
    expect(writable.abort).toHaveBeenCalledOnce()
  })

  it('canceling the save picker resolves to null (nothing written)', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn(() => Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))))
    expect(await openZipSink('nobg-images.zip')).toBeNull()
  })

  it('without the picker it falls back to the streaming download, or reports unsupported', () => {
    vi.stubGlobal('showSaveFilePicker', undefined)
    vi.stubGlobal('isSecureContext', true)
    const hadSw = 'serviceWorker' in navigator
    if (!hadSw) Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    expect(zipSaveMethod()).toBe('download-stream')
    vi.stubGlobal('isSecureContext', false)
    expect(zipSaveMethod()).toBe('unsupported')
    if (!hadSw) delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })
})
