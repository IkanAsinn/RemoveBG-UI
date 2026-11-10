import { afterEach, describe, expect, it } from 'vitest'
import { createSessionStore } from '../domain'
import { batchInput, createBatch, currentBatch, discardBatch } from './queue'
import { BATCH_MAX_BYTES, formatBytes, validateBatch } from './validate'

/** A File whose reported size is `size` without allocating it. */
function file(name: string, size = 1000, type = 'image/jpeg'): File {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const many = (n: number, size = 1000) => Array.from({ length: n }, (_, i) => file(`img-${i + 1}.jpg`, size))

describe('validateBatch (FR-38, FR-39, NFR-6)', () => {
  it('accepts 1–20 images within 100 MB and sums file sizes', () => {
    const r = validateBatch(many(20, 5 * 1024 * 1024))
    expect(r).toMatchObject({ ok: true, totalBytes: 20 * 5 * 1024 * 1024, skipped: 0 })
    if (r.ok) expect(r.files).toHaveLength(20)
  })

  it('blocks more than 20 images with the PRD message', () => {
    expect(validateBatch(many(21))).toMatchObject({ ok: false, code: 'too-many', message: 'Maximum 20 images per batch.' })
  })

  it('exactly 104,857,600 bytes is allowed; one byte more is blocked with the total and the cap', () => {
    expect(validateBatch([file('a.jpg', BATCH_MAX_BYTES / 2), file('b.jpg', BATCH_MAX_BYTES / 2)]).ok).toBe(true)
    const r = validateBatch([file('a.jpg', BATCH_MAX_BYTES / 2), file('b.jpg', BATCH_MAX_BYTES / 2 + 1)])
    expect(r).toMatchObject({ ok: false, code: 'too-large', totalBytes: 104_857_601 })
    if (!r.ok) {
      expect(r.message).toContain('104,857,601 bytes')
      expect(r.message).toContain('100.00 MB') // does not round down to look like the cap
      expect(r.message).toContain('The limit is 100 MB (104,857,600 bytes)')
    }
    const big = validateBatch(many(3, 50 * 1024 * 1024))
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.message).toMatch(/^Selected images total 150\.0 MB \(157,286,400 bytes\)/)
  })

  it('ignores non-image files and reports how many were skipped', () => {
    const r = validateBatch([file('a.jpg'), file('notes.txt', 10, 'text/plain'), file('b.heic', 10, '')])
    expect(r).toMatchObject({ ok: true, skipped: 1 })
    expect(validateBatch([file('notes.txt', 10, 'text/plain')])).toMatchObject({ ok: false, code: 'empty' })
  })

  it('formats sizes for display', () => {
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB')
  })
})

describe('batch queue records (FR-40)', () => {
  const store = createSessionStore()
  afterEach(() => void store.reset())

  it('creates one ready BatchJob with one queued item per file, keeping the files in memory', () => {
    const files = many(3)
    const job = createBatch(files, 3000, store)
    expect(job).toMatchObject({ status: 'ready', totalInputBytes: 3000 })
    expect(job.items.map((i) => i.status)).toEqual(['queued', 'queued', 'queued'])
    expect(job.items.map((i) => batchInput(i.sourceImageId))).toEqual(files)
    expect(currentBatch(store.getState())).toBe(job)
    // No decode yet: SourceImages are created one at a time during processing (NFR-16).
    expect(store.getState().sourceImages).toEqual({})
  })

  it('discarding a batch removes the job and its inputs', () => {
    const job = createBatch(many(2), 2000, store)
    discardBatch(job.id, store)
    expect(store.getState().batchJobs).toEqual({})
    expect(batchInput(job.items[0].sourceImageId)).toBeUndefined()
  })
})
