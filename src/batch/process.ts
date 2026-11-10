// LOCAL /batch/process (FR-41, FR-42, FR-45, FR-46, NFR-9, NFR-16, NFR-17).
// Items run strictly one at a time. Each item is decoded, matted and encoded; any failure marks only that item
// Failed with a short reason and the batch moves on. After an item finishes, its full-resolution bitmaps are
// released, so at most one decoded image is alive at any moment. What stays per item is the matte (for per-item
// brushing, T-023) and the encoded output (for the ZIP, T-024).
//
// Models (user decision for this task): the tiny model is required. If it cannot load, the batch does not start.
// The full model is used when the device passes the capability gate and it loads. If it fails to load or run, the
// remaining items continue on the tiny model.

import { createSourceImage, sessionStore, type BatchItem, type CutoutResult, type SessionStore, type SourceImage } from '../domain'
import { encodeCanvas, renderOutput } from '../composite/output'
import { ingestImage } from '../image/ingest'
import { GpuLostError, type ModelHandle } from '../model/loader'
import { CanvasTooLargeError, removeBackground } from '../matte/remove'
import { batchInput, setBatchOutput } from './queue'

export type BatchFailure = 'decode' | 'too-large' | 'remove' | 'encode' | 'missing'

/** Short, user-facing reasons shown in the queue and the failure summary (FR-45). */
export const FAILURE_REASON: Record<BatchFailure, string> = {
  decode: 'Could not decode image',
  'too-large': 'Image too large for this device',
  remove: 'Background removal failed',
  encode: 'Could not encode output',
  missing: 'File is no longer available',
}

export const failureReason = (code: string | null): string => FAILURE_REASON[code as BatchFailure] ?? 'Processing failed'

export class BatchModelUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Could not load the background-removal model. Check your connection and retry.')
    this.name = 'BatchModelUnavailableError'
    this.cause = cause
  }
}

export interface BatchDeps {
  /** The required (tiny) model. Rejecting means the batch must not start (NFR-17). */
  loadTiny: () => Promise<ModelHandle>
  /** The full model when this device qualifies, else null. Rejections fall back to the tiny model. */
  loadFull?: () => Promise<ModelHandle | null>
  /** Called when the full model is dropped (failed to load/run, or GPU lost), so its cache entry can be evicted. */
  onFullFailed?: (handle: ModelHandle | null, error: unknown) => void
  decode?: (file: File) => Promise<Omit<SourceImage, 'id'>>
  remove?: (handle: ModelHandle, image: SourceImage) => Promise<CutoutResult>
  encode?: (image: SourceImage, cutout: CutoutResult, store: SessionStore) => Promise<Blob>
  /** Lets the UI paint between items. */
  yieldToUi?: () => Promise<void>
  store?: SessionStore
}

const running = new Set<string>()
export const isBatchRunning = (jobId: string): boolean => running.has(jobId)

const defaultEncode = (image: SourceImage, cutout: CutoutResult, store: SessionStore) =>
  encodeCanvas(
    renderOutput({
      source: image.decodedBitmap,
      width: image.width,
      height: image.height,
      alphaMask: cutout.alphaMask,
      background: store.getState().background,
    }),
  )

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0))

function classify(stage: 'decode' | 'remove' | 'encode', e: unknown): BatchFailure {
  if (e instanceof CanvasTooLargeError) return 'too-large'
  return stage
}

/** Resolve the model to start with; throws BatchModelUnavailableError when the required tiny model is missing. */
async function prepareModels(deps: BatchDeps): Promise<{ tiny: ModelHandle; full: ModelHandle | null }> {
  let tiny: ModelHandle
  try {
    tiny = await deps.loadTiny()
  } catch (e) {
    throw new BatchModelUnavailableError(e)
  }
  let full: ModelHandle | null = null
  try {
    full = (await deps.loadFull?.()) ?? null
  } catch (e) {
    deps.onFullFailed?.(null, e)
  }
  return { tiny, full }
}

export interface BatchRunSummary {
  done: number
  failed: Array<{ itemId: string; fileName: string; reason: string }>
}

/**
 * Process every queued item of a batch, one at a time. Resolves with a summary; rejects only with
 * BatchModelUnavailableError, before any item has started.
 */
export async function processBatch(jobId: string, deps: BatchDeps): Promise<BatchRunSummary> {
  const store = deps.store ?? sessionStore
  if (running.has(jobId)) throw new Error('This batch is already running')
  const job = store.getState().batchJobs[jobId]
  if (!job) throw new Error('Batch not found')
  running.add(jobId)
  try {
    // "processing" with no item processing yet = preparing the model; reverted if the required model is missing.
    store.update('batchJobs', jobId, { status: 'processing' })
    let models: Awaited<ReturnType<typeof prepareModels>>
    try {
      models = await prepareModels(deps)
    } catch (e) {
      if (store.getState().batchJobs[jobId]) store.update('batchJobs', jobId, { status: 'ready' })
      throw e
    }
    let model = models.full ?? models.tiny

    const patchItem = (itemId: string, patch: Partial<BatchItem>) => {
      const current = store.getState().batchJobs[jobId]
      if (!current) return false // batch was cleared meanwhile
      store.update('batchJobs', jobId, { items: current.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) })
      return true
    }
    for (const { id: itemId } of job.items) {
      const item = store.getState().batchJobs[jobId]?.items.find((i) => i.id === itemId)
      if (!item) break // batch cleared
      if (item.status !== 'queued') continue
      patchItem(itemId, { status: 'processing', errorCode: null })
      await (deps.yieldToUi ?? nextFrame)()

      let image: SourceImage | null = null
      let cutout: CutoutResult | null = null
      let stage: 'decode' | 'remove' | 'encode' = 'decode'
      try {
        const file = batchInput(item.sourceImageId)
        if (!file) {
          patchItem(itemId, { status: 'failed', errorCode: 'missing' })
          continue
        }
        const decoded = await (deps.decode ?? ((f: File) => ingestImage(f, f.name, 'batch')))(file)
        image = createSourceImage({ ...decoded, sourceKind: 'batch', id: item.sourceImageId })
        if (!store.getState().batchJobs[jobId]) break
        store.create('sourceImages', image)

        stage = 'remove'
        const remove = deps.remove ?? removeBackground
        try {
          cutout = await runModel(remove, model, image)
        } catch (e) {
          if (model === models.tiny) throw e
          // Full model failed (or its GPU was lost): drop it for the rest of the batch and retry this item on tiny.
          deps.onFullFailed?.(model, e)
          model = models.tiny
          cutout = await runModel(remove, model, image)
        }
        if (!store.getState().batchJobs[jobId]) break
        store.create('cutouts', cutout)

        stage = 'encode'
        const blob = await (deps.encode ?? defaultEncode)(image, cutout, store)
        setBatchOutput(itemId, blob)
        patchItem(itemId, { status: 'done', cutoutId: cutout.id, errorCode: null })
      } catch (e) {
        if (cutout && !store.getState().cutouts[cutout.id]) cutout.cutoutBitmap.close()
        patchItem(itemId, { status: 'failed', errorCode: classify(stage, e), cutoutId: cutout && store.getState().cutouts[cutout.id] ? cutout.id : null })
      } finally {
        // NFR-16: free this item's full-resolution bitmaps before the next one is decoded. The SourceImage keeps its
        // metadata and original blob (re-decoded on demand), the CutoutResult keeps its alpha mask.
        image?.decodedBitmap.close()
        cutout?.cutoutBitmap.close()
      }
    }

    const final = store.getState().batchJobs[jobId]
    if (!final) return { done: 0, failed: [] }
    const done = final.items.filter((i) => i.status === 'done').length
    store.update('batchJobs', jobId, { status: done > 0 ? 'complete' : 'failed' })
    const names = store.getState().sourceImages
    return {
      done,
      failed: final.items
        .filter((i) => i.status === 'failed')
        .map((i) => ({
          itemId: i.id,
          fileName: names[i.sourceImageId]?.fileName ?? batchInput(i.sourceImageId)?.name ?? 'Unknown file',
          reason: failureReason(i.errorCode),
        })),
    }
  } finally {
    running.delete(jobId)
  }
}

/** Run one model, failing fast if its GPU device is lost mid-run. */
function runModel(remove: NonNullable<BatchDeps['remove']>, handle: ModelHandle, image: SourceImage) {
  const lost = handle.gpuLost?.then((reason) => Promise.reject(new GpuLostError(reason)))
  return lost ? Promise.race([remove(handle, image), lost]) : remove(handle, image)
}
