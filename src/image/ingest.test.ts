import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { firstImageFile, ingestImage, IngestError, mimeTypeOf } from './ingest'
import { decodeHeic } from './heic'

vi.mock('./heic', async (importOriginal) => ({ ...(await importOriginal<typeof import('./heic')>()), decodeHeic: vi.fn() }))

const file = (name: string, type = '', body = 'x') => new File([body], name, { type })

describe('firstImageFile', () => {
  it('returns the first image file, skipping non-images', () => {
    const files = [file('notes.txt', 'text/plain'), file('a.png', 'image/png'), file('b.jpg', 'image/jpeg')]
    expect(firstImageFile(files)?.name).toBe('a.png')
  })
  it('recognises HEIC/AVIF by extension when the browser reports no type', () => {
    expect(firstImageFile([file('IMG_1.HEIC')])?.name).toBe('IMG_1.HEIC')
    expect(mimeTypeOf(file('x.avif'))).toBe('image/avif')
  })
  it('returns null for empty or cancelled selections', () => {
    expect(firstImageFile(null)).toBeNull()
    expect(firstImageFile([])).toBeNull()
  })
})

describe('ingestImage (LOCAL /image/ingest)', () => {
  const close = vi.fn()
  beforeEach(() => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        if ((await blob.text()) === 'corrupt') throw new DOMException('decode failed', 'InvalidStateError')
        return { width: 6000, height: 4000, close } as unknown as ImageBitmap
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('creates a SourceImage with metadata and the native decode path, with no size cap', async () => {
    const f = file('big.avif', '', 'ok')
    const img = await ingestImage(f, f.name, 'upload')
    expect(img).toMatchObject({
      fileName: 'big.avif',
      mimeType: 'image/avif',
      byteSize: 2,
      width: 6000,
      height: 4000,
      sourceKind: 'upload',
      decodePath: 'native',
    })
    expect(img.originalBlob).toBe(f)
    expect(img.decodedBitmap.width).toBe(6000)
    expect(img.id).toMatch(/[0-9a-f-]{36}/)
  })

  it('throws the FR-5 error naming the file when native decode fails', async () => {
    const f = file('broken.png', 'image/png', 'corrupt')
    await expect(ingestImage(f, f.name, 'upload')).rejects.toThrow(new IngestError('broken.png'))
    await expect(ingestImage(f, f.name, 'upload')).rejects.toThrow('broken.png: Unsupported or corrupt image.')
    expect(decodeHeic).not.toHaveBeenCalled() // non-HEIC never reaches the WASM decoder
  })
})

describe('HEIC WASM fallback (FR-5)', () => {
  const close = vi.fn()
  beforeEach(() => {
    vi.mocked(decodeHeic).mockReset()
    // Simulate a browser without native HEIC support.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new DOMException('no', 'InvalidStateError'))))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('retries a natively undecodable HEIC with the WASM decoder and records decodePath wasm-heic', async () => {
    vi.mocked(decodeHeic).mockResolvedValue({ width: 4032, height: 3024, close } as unknown as ImageBitmap)
    const f = file('IMG_0001.HEIC', '', 'heic-bytes')
    const img = await ingestImage(f, f.name, 'upload')
    expect(decodeHeic).toHaveBeenCalledWith(f)
    expect(img).toMatchObject({ decodePath: 'wasm-heic', width: 4032, height: 3024, mimeType: 'image/heic' })
  })

  it('shows the HEIC-specific error when both native and WASM decoding fail', async () => {
    vi.mocked(decodeHeic).mockRejectedValue(new Error('bad heic'))
    const f = file('IMG_0002.heic', 'image/heic', 'bad')
    const err = await ingestImage(f, f.name, 'upload').catch((e) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect(err.code).toBe('heic-failed')
    expect(err.message).toBe('IMG_0002.heic: HEIC decoding failed for this file.')
  })
})
