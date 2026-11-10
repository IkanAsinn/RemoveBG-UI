import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionStore, createSourceImage } from '../domain'
import { outputFileName, sourceBasename, uniqueNames } from '../export/naming'
import { batchZipEntries } from '../batch/zip'
import { createBatch, setBatchOutput } from '../batch/queue'
import { crc32, writeZip, ZIP_BUFFER_LIMIT, ZipIncompleteError, type ZipSink } from './stream'

/** Sink that records every chunk (test-only; the real sink writes to disk). */
function memorySink(failOnWrite?: number) {
  const chunks: Uint8Array[] = []
  const sink = {
    write: vi.fn(async (c: Uint8Array) => {
      if (failOnWrite !== undefined && sink.write.mock.calls.length === failOnWrite) throw new Error('disk full')
      chunks.push(c)
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  }
  const bytes = () => {
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let o = 0
    for (const c of chunks) all.set(c, (o += c.length) - c.length)
    return all
  }
  return { sink: sink as ZipSink & typeof sink, chunks, bytes }
}

/** Minimal ZIP reader: validates the end record, central directory and local headers, and checks CRCs. */
function readZip(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.length - 22
  expect(v.getUint32(eocd, true)).toBe(0x06054b50)
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const files: Array<{ name: string; data: Uint8Array; flags: number; method: number }> = []
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const crc = v.getUint32(p + 16, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen))
    expect(v.getUint32(local, true)).toBe(0x04034b50)
    expect(v.getUint32(local + 14, true)).toBe(crc)
    expect(v.getUint32(local + 18, true)).toBe(size)
    const start = local + 30 + v.getUint16(local + 26, true)
    const data = zip.subarray(start, start + size)
    expect(crc32(data)).toBe(crc)
    files.push({ name, data, flags: v.getUint16(p + 8, true), method: v.getUint16(p + 10, true) })
    p += 46 + nameLen
  }
  return files
}

const bytesOf = (n: number, seed: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
const entry = (name: string, data: Uint8Array<ArrayBuffer>) => ({ name, open: async () => new Blob([data]) })

describe('writeZip (FR-47, NFR-8)', () => {
  it('writes a valid archive with the exact entry bytes (STORE, UTF-8 names)', async () => {
    const a = bytesOf(5000, 1)
    const b = bytesOf(123, 2)
    const { sink, bytes } = memorySink()
    const result = await writeZip([entry('a-nobg.png', a), entry('ü-nobg.png', b)], sink)
    const files = readZip(bytes())
    expect(files.map((f) => f.name)).toEqual(['a-nobg.png', 'ü-nobg.png'])
    expect(files[0].data).toEqual(a)
    expect(files[1].data).toEqual(b)
    expect(files.every((f) => f.method === 0 && f.flags === 0x0800)).toBe(true)
    expect(result).toEqual({ entries: 2, bytes: bytes().length })
    expect(sink.close).toHaveBeenCalledOnce()
    expect(sink.abort).not.toHaveBeenCalled()
  })

  it('never hands the sink more than the buffer limit, and the limit is capped at 4 MB', async () => {
    const big = bytesOf(3 * 1024 * 1024 + 17, 3)
    const small = memorySink()
    await writeZip([entry('x.png', big), entry('y.png', big)], small.sink, { bufferLimit: 1024 * 1024 })
    expect(Math.max(...small.chunks.map((c) => c.length))).toBeLessThanOrEqual(1024 * 1024)
    expect(small.chunks.length).toBeGreaterThan(6) // streamed, not one blob
    expect(readZip(small.bytes())[1].data).toEqual(big)

    const capped = memorySink()
    const huge = bytesOf(9 * 1024 * 1024, 4)
    await writeZip([entry('z.png', huge)], capped.sink, { bufferLimit: 64 * 1024 * 1024 })
    expect(Math.max(...capped.chunks.map((c) => c.length))).toBeLessThanOrEqual(ZIP_BUFFER_LIMIT)
  })

  it('opens and reads one encoded output at a time', async () => {
    const events: string[] = []
    const tracked = (i: number, data: Uint8Array<ArrayBuffer>) => ({
      name: `${i}.png`,
      open: async () => {
        events.push(`open ${i}`)
        const blob = new Blob([data])
        const slice = blob.slice.bind(blob)
        blob.slice = ((...args: Parameters<Blob['slice']>) => (events.push(`read ${i}`), slice(...args))) as Blob['slice']
        return blob
      },
    })
    const { sink } = memorySink()
    await writeZip([0, 1, 2].map((i) => tracked(i, bytesOf(2 * 1024 * 1024, i))), sink)
    // Every read of entry i happens before entry i+1 is opened.
    for (let i = 0; i < 2; i++) expect(events.lastIndexOf(`read ${i}`)).toBeLessThan(events.indexOf(`open ${i + 1}`))
    expect(events.filter((e) => e.startsWith('open'))).toEqual(['open 0', 'open 1', 'open 2'])
  })

  it('a mid-stream write failure aborts the sink and reports an incomplete ZIP', async () => {
    const { sink } = memorySink(2) // second write fails
    const big = bytesOf(3 * 1024 * 1024, 5)
    const run = writeZip([entry('a.png', big), entry('b.png', big)], sink, { bufferLimit: 1024 * 1024 })
    await expect(run).rejects.toBeInstanceOf(ZipIncompleteError)
    await expect(run).rejects.toThrow('ZIP download was incomplete')
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(sink.close).not.toHaveBeenCalled()
  })

  it('a failure producing an entry also aborts', async () => {
    const { sink } = memorySink()
    const bad = { name: 'b.png', open: () => Promise.reject(new Error('encode failed')) }
    await expect(writeZip([entry('a.png', bytesOf(10, 1)), bad], sink)).rejects.toBeInstanceOf(ZipIncompleteError)
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(sink.close).not.toHaveBeenCalled()
  })

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('output names (FR-35)', () => {
  it('uses {source-basename}-nobg.{ext}', () => {
    expect(outputFileName('IMG_0001.HEIC', 'png')).toBe('IMG_0001-nobg.png')
    expect(outputFileName('archive.tar.gz', 'webp')).toBe('archive.tar-nobg.webp')
    expect(outputFileName('folder/sub\\.hidden', 'png')).toBe('.hidden-nobg.png')
    expect(sourceBasename('')).toBe('image')
  })
  it('suffixes collisions with an index, case-insensitively', () => {
    expect(uniqueNames(['a-nobg.png', 'b-nobg.png', 'a-nobg.png', 'A-nobg.png', 'a-nobg-2.png'])).toEqual([
      'a-nobg.png',
      'b-nobg.png',
      'a-nobg-2.png',
      'A-nobg-3.png',
      'a-nobg-2-2.png',
    ])
  })
})

describe('batchZipEntries (FR-44)', () => {
  const store = createSessionStore()
  afterEach(() => void store.reset())

  it('includes only Done items, with unique -nobg names', async () => {
    const files = ['shot.jpg', 'bad.png', 'shot.png', 'queued.png'].map((n) => new File(['x'], n, { type: 'image/png' }))
    const job = createBatch(files, 4, store)
    const statuses = ['done', 'failed', 'done', 'queued'] as const
    store.update('batchJobs', job.id, { items: job.items.map((i, n) => ({ ...i, status: statuses[n] })) })
    for (const [n, i] of job.items.entries()) {
      if (statuses[n] !== 'done') continue
      store.create('sourceImages', createSourceImage({
        id: i.sourceImageId, fileName: files[n].name, mimeType: 'image/png', byteSize: 1, width: 1, height: 1,
        sourceKind: 'batch', originalBlob: files[n], decodedBitmap: {} as ImageBitmap, decodePath: 'native',
      }))
      setBatchOutput(i.id, new Blob([`out-${n}`]))
    }
    const entries = batchZipEntries(store.getState().batchJobs[job.id], store)
    expect(entries.map((e) => e.name)).toEqual(['shot-nobg.png', 'shot-nobg-2.png'])
    expect(await (await entries[1].open()).text()).toBe('out-2')
  })
})
