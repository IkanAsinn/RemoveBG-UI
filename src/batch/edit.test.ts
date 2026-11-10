import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCutoutResult, createSessionStore, createSourceImage, type SessionStore } from '../domain'
import { closeBatchItem, openBatchItem, openBlockReason } from './edit'
import { batchOutput, createBatch, setBatchOutput, zipStreaming } from './queue'
import { encodeCanvas, renderOutput } from '../composite/output'
import { ingestImage } from '../image/ingest'

vi.mock('../image/ingest', async (orig) => ({ ...(await orig<typeof import('../image/ingest')>()), ingestImage: vi.fn() }))
vi.mock('../matte/remove', async (orig) => ({
  ...(await orig<typeof import('../matte/remove')>()),
  cutoutBitmapFromAlpha: vi.fn(async () => ({ width: 40, height: 30, close: vi.fn() })),
}))
vi.mock('../composite/output', async (orig) => ({
  ...(await orig<typeof import('../composite/output')>()),
  renderOutput: vi.fn(() => ({})),
  encodeCanvas: vi.fn(async () => new Blob(['edited'], { type: 'image/png' })),
}))

const bitmap = (w = 40) => ({ width: w, height: 30, close: vi.fn() }) as unknown as ImageBitmap

/** A processed batch: item 0 Done (bitmaps released), item 1 Failed, item 2 Queued. */
function processedBatch(store: SessionStore) {
  const job = createBatch([0, 1, 2].map((i) => new File(['x'], `f${i}.png`, { type: 'image/png' })), 3, store)
  const [a] = job.items
  const released = bitmap(0)
  store.create('sourceImages', createSourceImage({
    id: a.sourceImageId, fileName: 'f0.png', mimeType: 'image/png', byteSize: 1, width: 40, height: 30,
    sourceKind: 'batch', originalBlob: new Blob(['x']), decodedBitmap: released, decodePath: 'native',
  }))
  const cutout = store.create('cutouts', createCutoutResult({
    sourceImageId: a.sourceImageId, modelTier: 'tiny', cutoutBitmap: bitmap(0), alphaMask: new Uint8ClampedArray(1200), status: 'ready',
  }))
  store.update('batchJobs', job.id, {
    status: 'complete',
    items: job.items.map((i, n) => (n === 0 ? { ...i, status: 'done', cutoutId: cutout.id } : n === 1 ? { ...i, status: 'failed', errorCode: 'decode' } : i)),
  })
  setBatchOutput(a.id, new Blob(['auto'], { type: 'image/png' }))
  return { jobId: job.id, items: store.getState().batchJobs[job.id].items, cutoutId: cutout.id }
}

const store = createSessionStore()
beforeEach(() => {
  vi.mocked(ingestImage).mockImplementation(async (blob, fileName) =>
    createSourceImage({ fileName, mimeType: 'image/png', byteSize: 1, width: 40, height: 30, sourceKind: 'batch', originalBlob: blob, decodedBitmap: bitmap(), decodePath: 'native' }),
  )
})
afterEach(() => {
  store.reset()
  vi.clearAllMocks()
})

describe('openBlockReason (FR-43)', () => {
  it('only Done items can be opened, and not while processing or zipping', () => {
    const { jobId, items } = processedBatch(store)
    expect(openBlockReason(jobId, items[0].id, store)).toBeNull()
    expect(openBlockReason(jobId, items[1].id, store)).toBe('not-done') // Failed
    expect(openBlockReason(jobId, items[2].id, store)).toBe('not-done') // Queued
    store.update('batchJobs', jobId, { status: 'processing' })
    expect(openBlockReason(jobId, items[0].id, store)).toBe('processing')
    store.update('batchJobs', jobId, { status: 'complete' })
    zipStreaming.set(jobId, true)
    expect(openBlockReason(jobId, items[0].id, store)).toBe('zipping')
    zipStreaming.set(jobId, false)
  })
})

describe('open and close a batch item', () => {
  it('opening re-decodes the source, rebuilds the cutout, links an EditState and marks the batch editing', async () => {
    const { jobId, items, cutoutId } = processedBatch(store)
    await openBatchItem(jobId, items[0].id, store)
    const s = store.getState()
    expect(s.sourceImages[items[0].sourceImageId].decodedBitmap.width).toBe(40)
    expect(s.cutouts[cutoutId].cutoutBitmap.width).toBe(40)
    const item = s.batchJobs[jobId].items[0]
    expect(s.editStates[item.editStateId!].cutoutId).toBe(cutoutId)
    expect(s.batchJobs[jobId].status).toBe('editing')
    await expect(openBatchItem(jobId, items[1].id, store)).rejects.toThrow('not-done')
  })

  it('closing re-encodes with the edits, marks the item edited, releases bitmaps and restores the batch status', async () => {
    const { jobId, items } = processedBatch(store)
    await openBatchItem(jobId, items[0].id, store)
    const opened = store.getState()
    const editId = opened.batchJobs[jobId].items[0].editStateId!
    store.update('editStates', editId, { edgeValue: 70, crop: { x: 0, y: 0, width: 20, height: 30 } })
    const src = opened.sourceImages[items[0].sourceImageId].decodedBitmap

    await closeBatchItem(jobId, items[0].id, store)
    expect(vi.mocked(renderOutput).mock.calls[0][0].edit).toMatchObject({ edgeValue: 70, crop: { width: 20 } })
    expect(await batchOutput(items[0].id)!.text()).toBe('edited')
    const after = store.getState().batchJobs[jobId]
    expect(after.items[0]).toMatchObject({ status: 'done', edited: true, editStateId: editId })
    expect(after.items.slice(1).map((i) => i.status)).toEqual(['failed', 'queued']) // other rows untouched
    expect(after.status).toBe('complete')
    expect(src.close).toHaveBeenCalled()
  })

  it('closing without changes leaves the item unedited', async () => {
    const { jobId, items } = processedBatch(store)
    await openBatchItem(jobId, items[0].id, store)
    await closeBatchItem(jobId, items[0].id, store)
    expect(store.getState().batchJobs[jobId].items[0].edited).toBe(false)
  })

  it('an encode failure on close marks the item Failed and drops its stale output', async () => {
    const { jobId, items } = processedBatch(store)
    await openBatchItem(jobId, items[0].id, store)
    vi.mocked(encodeCanvas).mockRejectedValueOnce(new Error('enc'))
    await closeBatchItem(jobId, items[0].id, store)
    expect(store.getState().batchJobs[jobId].items[0]).toMatchObject({ status: 'failed', errorCode: 'encode' })
    expect(batchOutput(items[0].id)).toBeUndefined()
    expect(store.getState().batchJobs[jobId].status).toBe('failed') // no Done items left
  })
})
