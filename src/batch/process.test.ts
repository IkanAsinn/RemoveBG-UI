import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCutoutResult, createSessionStore, type CutoutResult, type SourceImage } from '../domain'
import type { ModelHandle } from '../model/loader'
import { BatchModelUnavailableError, processBatch, type BatchDeps } from './process'
import { batchOutput, createBatch } from './queue'

const store = createSessionStore()
afterEach(() => void store.reset())

const tiny = { tier: 'tiny', backend: 'wasm' } as ModelHandle
const full = { tier: 'full', backend: 'webgpu' } as ModelHandle
const files = (...names: string[]) => names.map((n) => new File(['x'], n, { type: 'image/png' }))
const bitmap = () => ({ width: 40, height: 30, close: vi.fn() }) as unknown as ImageBitmap

/** Fake pipeline that records ordering, concurrency and bitmap lifetimes. */
function harness(over: Partial<BatchDeps> = {}) {
  const events: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const liveBitmaps = new Set<ImageBitmap>()
  let maxLive = 0
  const track = (b: ImageBitmap) => {
    liveBitmaps.add(b)
    maxLive = Math.max(maxLive, [...liveBitmaps].filter((x) => x.width === 40).length)
    ;(b.close as ReturnType<typeof vi.fn>).mockImplementation(() => liveBitmaps.delete(b))
    return b
  }
  const deps: BatchDeps = {
    store,
    yieldToUi: async () => {},
    loadTiny: async () => tiny,
    decode: async (file) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`decode ${file.name}`)
      await Promise.resolve()
      inFlight--
      if (file.name.startsWith('corrupt')) throw new Error('decode failed')
      const b = track(bitmap())
      return {
        fileName: file.name,
        mimeType: 'image/png',
        byteSize: file.size,
        width: 40,
        height: 30,
        sourceKind: 'batch',
        originalBlob: file,
        decodedBitmap: b,
        decodePath: 'native',
      }
    },
    remove: async (handle, image: SourceImage): Promise<CutoutResult> => {
      events.push(`remove ${image.fileName} ${handle.tier}`)
      return createCutoutResult({
        sourceImageId: image.id,
        modelTier: handle.tier,
        cutoutBitmap: track({ width: 40, height: 30, close: vi.fn() } as unknown as ImageBitmap),
        alphaMask: new Uint8ClampedArray(40 * 30),
        status: 'ready',
      })
    },
    encode: async (image) => {
      events.push(`encode ${image.fileName}`)
      return new Blob(['png'], { type: 'image/png' })
    },
    ...over,
  }
  return { deps, events, stats: () => ({ maxInFlight, maxLive }) }
}

const items = (jobId: string) => store.getState().batchJobs[jobId].items

describe('processBatch (FR-41, NFR-9, NFR-16)', () => {
  it('runs exactly one image at a time, in order, and marks each Done', async () => {
    const job = createBatch(files('a.png', 'b.png', 'c.png'), 3, store)
    const h = harness()
    const seen: string[][] = []
    const unsub = store.subscribe(() => {
      const j = store.getState().batchJobs[job.id]
      if (j) seen.push(j.items.map((i) => i.status))
    })
    const summary = await processBatch(job.id, h.deps)
    unsub()
    expect(h.events).toEqual([
      'decode a.png', 'remove a.png tiny', 'encode a.png',
      'decode b.png', 'remove b.png tiny', 'encode b.png',
      'decode c.png', 'remove c.png tiny', 'encode c.png',
    ])
    expect(h.stats().maxInFlight).toBe(1)
    // Row status advanced item by item: never two "processing" rows at once.
    expect(seen.some((s) => s.join() === 'processing,queued,queued')).toBe(true)
    expect(seen.some((s) => s.join() === 'done,processing,queued')).toBe(true)
    expect(seen.every((s) => s.filter((x) => x === 'processing').length <= 1)).toBe(true)
    expect(items(job.id).map((i) => i.status)).toEqual(['done', 'done', 'done'])
    expect(store.getState().batchJobs[job.id].status).toBe('complete')
    expect(summary).toEqual({ done: 3, failed: [] })
    expect(batchOutput(job.items[0].id)?.type).toBe('image/png')
  })

  it('releases each item’s full-resolution bitmaps before decoding the next (at most one decoded image alive)', async () => {
    const job = createBatch(files('a.png', 'b.png', 'c.png'), 3, store)
    const h = harness()
    await processBatch(job.id, h.deps)
    expect(h.stats().maxLive).toBeLessThanOrEqual(2) // the source and its cutout, for one image only
    // Done items keep metadata, the matte and the encoded output.
    const done = items(job.id)[0]
    expect(store.getState().sourceImages[done.sourceImageId]).toMatchObject({ fileName: 'a.png', width: 40, height: 30 })
    expect(store.getState().cutouts[done.cutoutId!].alphaMask).toHaveLength(1200)
  })
})

describe('failure isolation (FR-42, FR-45, FR-46)', () => {
  it('a corrupt item is marked Failed with a reason and the rest continue', async () => {
    const job = createBatch(files('a.png', 'corrupt.png', 'c.png'), 3, store)
    const summary = await processBatch(job.id, harness().deps)
    expect(items(job.id).map((i) => [i.status, i.errorCode])).toEqual([
      ['done', null],
      ['failed', 'decode'],
      ['done', null],
    ])
    expect(summary.failed).toEqual([{ itemId: job.items[1].id, fileName: 'corrupt.png', reason: 'Could not decode image' }])
    expect(store.getState().batchJobs[job.id].status).toBe('complete')
  })

  it('removal and encode failures are reported per item', async () => {
    const job = createBatch(files('a.png', 'b.png', 'c.png'), 3, store)
    const h = harness()
    const remove = h.deps.remove!
    const encode = h.deps.encode!
    h.deps.remove = async (m, img) => (img.fileName === 'a.png' ? Promise.reject(new Error('oom')) : remove(m, img))
    h.deps.encode = async (img, c, s) => (img.fileName === 'b.png' ? Promise.reject(new Error('enc')) : encode(img, c, s))
    const summary = await processBatch(job.id, h.deps)
    expect(summary.failed.map((f) => [f.fileName, f.reason])).toEqual([
      ['a.png', 'Background removal failed'],
      ['b.png', 'Could not encode output'],
    ])
    expect(items(job.id)[2].status).toBe('done')
  })

  it('when every item fails the batch is marked failed with each file listed, and no output exists', async () => {
    const job = createBatch(files('corrupt-1.png', 'corrupt-2.png'), 2, store)
    const summary = await processBatch(job.id, harness().deps)
    expect(store.getState().batchJobs[job.id].status).toBe('failed')
    expect(summary.done).toBe(0)
    expect(summary.failed.map((f) => f.fileName)).toEqual(['corrupt-1.png', 'corrupt-2.png'])
    expect(job.items.every((i) => batchOutput(i.id) === undefined)).toBe(true)
  })
})

describe('models (NFR-17, batch model choice)', () => {
  it('does not start when the required tiny model is unavailable', async () => {
    const job = createBatch(files('a.png', 'b.png'), 2, store)
    const h = harness({ loadTiny: () => Promise.reject(new Error('offline')) })
    await expect(processBatch(job.id, h.deps)).rejects.toBeInstanceOf(BatchModelUnavailableError)
    expect(h.events).toEqual([]) // nothing decoded
    expect(items(job.id).map((i) => i.status)).toEqual(['queued', 'queued'])
    expect(store.getState().batchJobs[job.id].status).toBe('ready') // can be retried
  })

  it('uses the full model when available', async () => {
    const job = createBatch(files('a.png'), 1, store)
    const h = harness({ loadFull: async () => full })
    await processBatch(job.id, h.deps)
    expect(h.events).toContain('remove a.png full')
  })

  it('a full-model failure mid-batch retries that item on tiny and keeps tiny for the rest', async () => {
    const job = createBatch(files('a.png', 'b.png', 'c.png'), 3, store)
    const onFullFailed = vi.fn()
    const h = harness({ loadFull: async () => full, onFullFailed })
    const remove = h.deps.remove!
    h.deps.remove = async (m, img) => (m === full && img.fileName === 'b.png' ? Promise.reject(new Error('gpu')) : remove(m, img))
    await processBatch(job.id, h.deps)
    expect(h.events.filter((e) => e.startsWith('remove'))).toEqual(['remove a.png full', 'remove b.png tiny', 'remove c.png tiny'])
    expect(onFullFailed).toHaveBeenCalledTimes(1)
    expect(items(job.id).map((i) => i.status)).toEqual(['done', 'done', 'done'])
  })

  it('a full model that fails to load falls back to tiny', async () => {
    const job = createBatch(files('a.png'), 1, store)
    const h = harness({ loadFull: () => Promise.reject(new Error('fetch')) })
    await processBatch(job.id, h.deps)
    expect(h.events).toContain('remove a.png tiny')
  })

  it('a running batch cannot be started twice', async () => {
    const job = createBatch(files('a.png'), 1, store)
    const h = harness()
    const first = processBatch(job.id, h.deps)
    await expect(processBatch(job.id, h.deps)).rejects.toThrow('already running')
    await first
  })
})
