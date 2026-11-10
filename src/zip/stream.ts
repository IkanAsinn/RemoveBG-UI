// LOCAL /zip/stream (FR-44, FR-47, FR-49, NFR-8). A streaming ZIP writer:
//  - entries are opened one at a time (`open()` returns that entry's encoded blob) and released after writing, so
//    at most one encoded output is held at once;
//  - bytes go to an injected sink through a single staging buffer of at most 4 MB; the archive is never assembled
//    in memory;
//  - any failure aborts the sink and throws ZipIncompleteError, so a partial file is never reported as success.
// Entries use STORE (PNG/WebP/JXL are already compressed). Each entry's CRC-32 is computed in a first pass over its
// in-memory blob, so local headers carry real sizes and no data descriptors are needed (widest unzip compatibility).

export const ZIP_BUFFER_LIMIT = 4 * 1024 * 1024

/** Minimal streaming sink; matches FileSystemWritableFileStream and WritableStreamDefaultWriter. */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

export interface ZipEntrySource {
  /** Final entry name (already unique, see uniqueNames). */
  name: string
  /** Produce this entry's bytes. Called once, right before the entry is written. */
  open: () => Promise<Blob>
}

export interface ZipResult {
  entries: number
  bytes: number
}

export class ZipIncompleteError extends Error {
  constructor(cause?: unknown) {
    super('ZIP download was incomplete')
    this.name = 'ZipIncompleteError'
    this.cause = cause
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/** MS-DOS date/time used by ZIP headers. */
function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

const READ_CHUNK = 1024 * 1024
const MAX_U32 = 0xffffffff

/** Read a blob in bounded slices. */
async function* slices(blob: Blob, size = READ_CHUNK): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += size) {
    yield new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer())
  }
}

/** Single bounded staging buffer in front of the sink. */
class Staging {
  private buf: Uint8Array
  private used = 0
  written = 0
  private sink: ZipSink
  constructor(sink: ZipSink, limit: number) {
    this.sink = sink
    this.buf = new Uint8Array(limit)
  }
  async push(data: Uint8Array) {
    let at = 0
    while (at < data.length) {
      const n = Math.min(this.buf.length - this.used, data.length - at)
      this.buf.set(data.subarray(at, at + n), this.used)
      this.used += n
      at += n
      if (this.used === this.buf.length) await this.flush()
    }
  }
  async flush() {
    if (this.used === 0) return
    // Hand the sink its own copy: sinks may keep the chunk (e.g. queue it) while we reuse the buffer.
    const chunk = this.buf.slice(0, this.used)
    this.used = 0
    await this.sink.write(chunk)
    this.written += chunk.length
  }
}

const utf8 = new TextEncoder()

/**
 * Write `entries` as a ZIP archive to `sink`. Resolves after the sink is closed; on any failure the sink is aborted
 * and ZipIncompleteError is thrown.
 */
export async function writeZip(
  entries: ZipEntrySource[],
  sink: ZipSink,
  options: { bufferLimit?: number; now?: Date } = {},
): Promise<ZipResult> {
  const limit = Math.min(options.bufferLimit ?? ZIP_BUFFER_LIMIT, ZIP_BUFFER_LIMIT)
  const out = new Staging(sink, limit)
  const { time, date } = dosDateTime(options.now ?? new Date())
  const central: Uint8Array[] = []
  let offset = 0
  try {
    for (const entry of entries) {
      const name = utf8.encode(entry.name)
      let blob: Blob | null = await entry.open()
      const size = blob.size
      let crc = 0
      for await (const part of slices(blob)) crc = crc32(part, crc)
      if (size > MAX_U32 || offset > MAX_U32) throw new Error('Archive exceeds 4 GB (ZIP64 not supported)')

      // Local file header (30 bytes + name).
      const local = new DataView(new ArrayBuffer(30))
      local.setUint32(0, 0x04034b50, true)
      local.setUint16(4, 20, true) // version needed: 2.0
      local.setUint16(6, 0x0800, true) // UTF-8 names
      local.setUint16(8, 0, true) // STORE
      local.setUint16(10, time, true)
      local.setUint16(12, date, true)
      local.setUint32(14, crc, true)
      local.setUint32(18, size, true)
      local.setUint32(22, size, true)
      local.setUint16(26, name.length, true)
      local.setUint16(28, 0, true)
      await out.push(new Uint8Array(local.buffer))
      await out.push(name)
      for await (const part of slices(blob)) await out.push(part)
      blob = null // release this entry's encoded output before opening the next one

      // Central directory record (46 bytes + name), kept until the end (small: ~100 bytes per entry).
      const rec = new DataView(new ArrayBuffer(46 + name.length))
      rec.setUint32(0, 0x02014b50, true)
      rec.setUint16(4, 20, true) // version made by
      rec.setUint16(6, 20, true)
      rec.setUint16(8, 0x0800, true)
      rec.setUint16(10, 0, true)
      rec.setUint16(12, time, true)
      rec.setUint16(14, date, true)
      rec.setUint32(16, crc, true)
      rec.setUint32(20, size, true)
      rec.setUint32(24, size, true)
      rec.setUint16(28, name.length, true)
      rec.setUint32(42, offset, true)
      new Uint8Array(rec.buffer).set(name, 46)
      central.push(new Uint8Array(rec.buffer))
      offset += 30 + name.length + size
    }

    const cdStart = offset
    let cdSize = 0
    for (const rec of central) {
      await out.push(rec)
      cdSize += rec.length
    }
    if (cdStart + cdSize > MAX_U32 || central.length > 0xffff) throw new Error('Archive exceeds ZIP limits')
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, central.length, true)
    end.setUint16(10, central.length, true)
    end.setUint32(12, cdSize, true)
    end.setUint32(16, cdStart, true)
    await out.push(new Uint8Array(end.buffer))
    await out.flush()
    await sink.close()
    return { entries: central.length, bytes: out.written }
  } catch (e) {
    try {
      await sink.abort(e)
    } catch {
      // the sink is already broken; the error below is what matters
    }
    throw new ZipIncompleteError(e)
  }
}
