// Batch → ZIP entries (FR-44, FR-35). Only Done items are included; Failed, Queued and Processing items never are.
// Each entry's bytes are fetched lazily by the writer, one entry at a time.

import { sessionStore, type BatchJob, type SessionStore } from '../domain'
import { outputFileName, uniqueNames } from '../export/naming'
import type { ZipEntrySource } from '../zip/stream'
import { batchInput, batchOutput } from './queue'

export type OutputProvider = (itemId: string) => Promise<Blob>

const storedOutput: OutputProvider = async (itemId) => {
  const blob = batchOutput(itemId)
  if (!blob) throw new Error(`No output for batch item ${itemId}`)
  return blob
}

export function batchZipEntries(job: BatchJob, store: SessionStore = sessionStore, provide: OutputProvider = storedOutput): ZipEntrySource[] {
  const done = job.items.filter((i) => i.status === 'done')
  const names = uniqueNames(
    done.map((i) => {
      const source = store.getState().sourceImages[i.sourceImageId]?.fileName ?? batchInput(i.sourceImageId)?.name ?? 'image'
      return outputFileName(source, 'png')
    }),
  )
  return done.map((item, n) => ({ name: names[n], open: () => provide(item.id) }))
}
