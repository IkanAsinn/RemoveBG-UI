// @vitest-environment node
// Runs the real bundled libheif WASM decoder against real HEIC bytes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeHeicToRgba, isHeif } from './heic'

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, '__fixtures__', name)))

const pixel = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return Array.from(img.data.subarray(i, i + 4))
}

describe('decodeHeicToRgba (LOCAL /image/decode-heic)', () => {
  it('decodes a real HEIC file to full-resolution RGBA', async () => {
    const img = await decodeHeicToRgba(fixture('photo.heic'))
    expect([img.width, img.height]).toEqual([1024, 768])
    expect(img.data.length).toBe(1024 * 768 * 4)
    // Fixture: blue background (40,90,160) with a yellow (240,200,40) circle in the middle. Lossy, so allow drift.
    const [r, g, b, a] = pixel(img, 512, 384)
    expect(r).toBeGreaterThan(200)
    expect(g).toBeGreaterThan(160)
    expect(b).toBeLessThan(90)
    expect(a).toBe(255)
    const [cr, , cb] = pixel(img, 10, 10)
    expect(cb).toBeGreaterThan(cr + 60)
  })

  it('rejects a truncated HEIC file', async () => {
    await expect(decodeHeicToRgba(fixture('corrupt.heic'))).rejects.toThrow()
  })
})

describe('isHeif', () => {
  it('detects HEIC by extension, MIME type, or ftyp brand', async () => {
    expect(await isHeif(new Blob([]), 'IMG_0001.HEIC')).toBe(true)
    expect(await isHeif(new Blob([], { type: 'image/heif' }), 'x')).toBe(true)
    expect(await isHeif(new Blob([fixture('photo.heic')]), 'renamed.jpg')).toBe(true)
    expect(await isHeif(new Blob(['\x89PNG\r\n\x1a\n0000']), 'a.png')).toBe(false)
  })
})
