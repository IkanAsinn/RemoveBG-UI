// Batch queue records (FR-40). A validated selection becomes one BatchJob with one BatchItem per image. Each item
// reserves the id of its SourceImage; the SourceImage itself (decoded bitmap, dimensions) is created when that item
// is processed, one at a time, so the queue never holds several full-resolution decodes at once (NFR-16).
// The selected File handles live here, in memory only (FR-51).

import { createBatchItem, createBatchJob, newId, sessionStore, type BatchJob, type SessionState } from '../domain'

const inputs = new Map<string, File>()
/** Encoded output per batch item id (T-022), read by the ZIP writer. Memory only. */
const outputs = new Map<string, Blob>()

export const batchOutput = (itemId: string): Blob | undefined => outputs.get(itemId)
export const setBatchOutput = (itemId: string, blob: Blob): void => void outputs.set(itemId, blob)
export const deleteBatchOutput = (itemId: string): void => void outputs.delete(itemId)

/** The original file for a batch item's (reserved) SourceImage id. */
export const batchInput = (sourceImageId: string): File | undefined => inputs.get(sourceImageId)

/** Create the BatchJob and its items for files that already passed validateBatch. */
export function createBatch(files: File[], totalBytes: number, store = sessionStore): BatchJob {
  const items = files.map((file) => {
    const sourceImageId = newId()
    inputs.set(sourceImageId, file)
    return createBatchItem(sourceImageId)
  })
  return store.create('batchJobs', createBatchJob(items, totalBytes, { status: 'ready' }))
}

/** Drop a batch, its pending inputs and any images or results already derived from it. */
export function discardBatch(jobId: string, store = sessionStore): void {
  const job = store.getState().batchJobs[jobId]
  if (!job) return
  for (const item of job.items) {
    inputs.delete(item.sourceImageId)
    outputs.delete(item.id)
    editCounts.delete(jobId)
    if (item.editStateId) store.remove('editStates', item.editStateId)
    if (item.cutoutId) store.remove('cutouts', item.cutoutId)
    store.remove('sourceImages', item.sourceImageId)
  }
  store.remove('batchJobs', jobId)
}

/** The session's current batch (v1 has at most one). */
export const currentBatch = (state: SessionState): BatchJob | undefined => Object.values(state.batchJobs).at(-1)

/**
 * ZIP streaming in progress per batch (set by the ZIP writer, T-024). While set, batch items cannot be opened for
 * editing (PRD: the editor is disabled once ZIP streaming begins).
 */
const zipping = new Set<string>()
const zipListeners = new Set<() => void>()
let zipVersion = 0
export const zipStreaming = {
  has: (jobId: string): boolean => zipping.has(jobId),
  set(jobId: string, active: boolean): void {
    if (active === zipping.has(jobId)) return
    if (active) zipping.add(jobId)
    else zipping.delete(jobId)
    zipVersion++
    zipListeners.forEach((l) => l())
  },
  subscribe(listener: () => void): () => void {
    zipListeners.add(listener)
    return () => zipListeners.delete(listener)
  },
  getVersion: (): number => zipVersion,
}

/**
 * Batch edits not yet in a saved ZIP (FR-52). Each saved edit bumps the batch's edit count; a successful ZIP records
 * the count it included.
 */
const editCounts = new Map<string, { edits: number; zipped: number }>()
export const batchEditsPending = (jobId: string): boolean => {
  const c = editCounts.get(jobId)
  return !!c && c.edits > c.zipped
}
export function noteBatchEdit(jobId: string): void {
  const c = editCounts.get(jobId) ?? { edits: 0, zipped: 0 }
  editCounts.set(jobId, { ...c, edits: c.edits + 1 })
}
export function noteZipSaved(jobId: string, editsIncluded: number): void {
  const c = editCounts.get(jobId)
  if (c) editCounts.set(jobId, { ...c, zipped: Math.max(c.zipped, editsIncluded) })
}
export const batchEditCount = (jobId: string): number => editCounts.get(jobId)?.edits ?? 0
