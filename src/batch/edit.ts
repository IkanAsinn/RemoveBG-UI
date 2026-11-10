// Per-item batch editing (FR-43). A Done item's full-resolution bitmaps were released after processing (NFR-16), so
// opening it re-decodes the original file and rebuilds the cutout from the stored matte; closing it re-encodes the
// output with the edits, records them on the BatchItem, and releases the bitmaps again. Only one item is open at a
// time, and never while the batch is processing or its ZIP is being written.

import { createEditState, hasEdits, sessionStore, type BatchItem, type SessionStore } from '../domain'
import { encodeCanvas, renderOutput } from '../composite/output'
import { ingestImage } from '../image/ingest'
import { cutoutBitmapFromAlpha } from '../matte/remove'
import { deleteBatchOutput, noteBatchEdit, setBatchOutput, zipStreaming } from './queue'

export type OpenBlockReason = 'not-done' | 'processing' | 'zipping' | 'missing'

/** Why an item cannot be opened right now, or null when it can. */
export function openBlockReason(jobId: string, itemId: string, store: SessionStore = sessionStore): OpenBlockReason | null {
  const job = store.getState().batchJobs[jobId]
  const item = job?.items.find((i) => i.id === itemId)
  if (!job || !item) return 'missing'
  if (zipStreaming.has(jobId)) return 'zipping'
  if (job.status === 'processing') return 'processing'
  if (item.status !== 'done') return 'not-done'
  return null
}

function patchItem(store: SessionStore, jobId: string, itemId: string, patch: Partial<BatchItem>) {
  const job = store.getState().batchJobs[jobId]
  if (job) store.update('batchJobs', jobId, { items: job.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) })
}

/** Prepare a Done item for the editor: decode, rebuild the cutout bitmap, ensure its EditState, mark the batch editing. */
export async function openBatchItem(jobId: string, itemId: string, store: SessionStore = sessionStore): Promise<void> {
  const blocked = openBlockReason(jobId, itemId, store)
  if (blocked) throw new Error(`Batch item cannot be opened: ${blocked}`)
  const item = store.getState().batchJobs[jobId].items.find((i) => i.id === itemId)!
  const image = store.getState().sourceImages[item.sourceImageId]
  const cutout = item.cutoutId ? store.getState().cutouts[item.cutoutId] : undefined
  if (!image || !cutout) throw new Error('Batch item cannot be opened: missing')

  const decoded = await ingestImage(image.originalBlob, image.fileName, 'batch')
  const bitmap = decoded.decodedBitmap
  const cutoutBitmap = await cutoutBitmapFromAlpha(bitmap, cutout.alphaMask, image.width, image.height)
  store.update('sourceImages', image.id, { decodedBitmap: bitmap })
  store.update('cutouts', cutout.id, { cutoutBitmap })

  let editStateId = item.editStateId
  if (!editStateId || !store.getState().editStates[editStateId]) {
    editStateId = store.create('editStates', createEditState(cutout.id)).id
  }
  patchItem(store, jobId, itemId, { editStateId })
  store.update('batchJobs', jobId, { status: 'editing' })
}

/**
 * Save the open item back to the batch: re-encode its output with the edits, set `edited`, release the bitmaps and
 * return the batch to "complete". If encoding fails the item is marked Failed (FR-42) and its old output is dropped.
 */
export async function closeBatchItem(jobId: string, itemId: string, store: SessionStore = sessionStore): Promise<void> {
  const state = store.getState()
  const item = state.batchJobs[jobId]?.items.find((i) => i.id === itemId)
  if (!item) return
  const image = state.sourceImages[item.sourceImageId]
  const cutout = item.cutoutId ? state.cutouts[item.cutoutId] : undefined
  const edit = item.editStateId ? state.editStates[item.editStateId] : undefined
  try {
    if (image && cutout) {
      const blob = await encodeCanvas(
        renderOutput({
          source: image.decodedBitmap,
          width: image.width,
          height: image.height,
          alphaMask: cutout.alphaMask,
          edit,
          background: store.getState().background,
        }),
      )
      setBatchOutput(itemId, blob)
    }
    if (hasEdits(edit)) noteBatchEdit(jobId)
    patchItem(store, jobId, itemId, { edited: hasEdits(edit) })
  } catch {
    deleteBatchOutput(itemId) // the ZIP must not ship a stale output for an item whose edits failed to encode
    patchItem(store, jobId, itemId, { status: 'failed', errorCode: 'encode', edited: hasEdits(edit) })
  } finally {
    image?.decodedBitmap.close()
    cutout?.cutoutBitmap.close()
    if (store.getState().batchJobs[jobId]) {
      const done = store.getState().batchJobs[jobId].items.some((i) => i.status === 'done')
      store.update('batchJobs', jobId, { status: done ? 'complete' : 'failed' })
    }
  }
}
