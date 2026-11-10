// "Download ZIP" for a batch (FR-44, FR-48, FR-49). Streams the Done items to the chosen destination. Editing is
// locked from the click until the write ends (zipStreaming), whatever the outcome.

import { sessionStore, type SessionStore } from '../domain'
import { openZipSink, ZipSaveCanceledError } from '../zip/save'
import { writeZip, ZipIncompleteError, type ZipSink } from '../zip/stream'
import { batchEditCount, noteZipSaved, zipStreaming } from './queue'
import { batchZipEntries, type OutputProvider } from './zip'

export const BATCH_ZIP_NAME = 'nobg-images.zip'

export type ZipOutcome =
  | { kind: 'saved'; entries: number }
  | { kind: 'canceled' } // save picker or browser download canceled: no ZIP
  | { kind: 'incomplete' } // write failed mid-way: the partial file is not a success
  | { kind: 'unsupported' }

export interface DownloadDeps {
  openSink?: (filename: string) => Promise<ZipSink | null>
  provide?: OutputProvider
  store?: SessionStore
}

/** Call straight from the click handler: the save picker opens before the first await. */
export async function downloadBatchZip(jobId: string, deps: DownloadDeps = {}): Promise<ZipOutcome> {
  const store = deps.store ?? sessionStore
  const job = store.getState().batchJobs[jobId]
  if (!job || !job.items.some((i) => i.status === 'done')) throw new Error('No completed images to download')
  zipStreaming.set(jobId, true)
  try {
    let sink: ZipSink | null
    try {
      sink = await (deps.openSink ?? openZipSink)(BATCH_ZIP_NAME)
    } catch {
      return { kind: 'unsupported' }
    }
    if (!sink) return { kind: 'canceled' }
    const editsIncluded = batchEditCount(jobId)
    try {
      const result = await writeZip(batchZipEntries(store.getState().batchJobs[jobId] ?? job, store, deps.provide), sink)
      noteZipSaved(jobId, editsIncluded)
      return { kind: 'saved', entries: result.entries }
    } catch (e) {
      if (e instanceof ZipIncompleteError && e.cause instanceof ZipSaveCanceledError) return { kind: 'canceled' }
      return { kind: 'incomplete' }
    }
  } finally {
    zipStreaming.set(jobId, false)
  }
}
