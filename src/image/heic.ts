// LOCAL /image/decode-heic — bundled WASM HEIC/HEIF decoder (FR-5, FR-6, FR-54, NFR-15).
// libheif-js's ESM bundle inlines the .wasm binary, and Vite emits it as a lazily loaded same-origin
// chunk: nothing is fetched until a HEIC file actually fails native decoding, and never from a CDN.

import type { LibHeif } from 'libheif-js/libheif-wasm/libheif-bundle.mjs'

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'mif2'])

let libPromise: Promise<LibHeif> | null = null

function loadLibheif(): Promise<LibHeif> {
  libPromise ??= import('libheif-js/libheif-wasm/libheif-bundle.mjs')
    .then((m) => m.default())
    .catch((e) => {
      libPromise = null // allow a retry if the chunk failed to load
      throw e
    })
  return libPromise
}

/** HEIC/HEIF by MIME type, extension, or ISO-BMFF `ftyp` brand (catches misnamed phone exports). */
export async function isHeif(blob: Blob, fileName: string): Promise<boolean> {
  if (/^image\/hei[cf](-sequence)?$/.test(blob.type) || /\.hei[cf]$/i.test(fileName)) return true
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  if (head.length < 12) return false
  const ascii = String.fromCharCode(...head.subarray(4, 12))
  return ascii.startsWith('ftyp') && HEIF_BRANDS.has(ascii.slice(4))
}

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Decode the primary image of a HEIC/HEIF file to RGBA pixels. Throws if nothing decodes. */
export async function decodeHeicToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  const lib = await loadLibheif()
  const images = new lib.HeifDecoder().decode(bytes)
  try {
    const image = images.find((i) => i.is_primary()) ?? images[0]
    if (!image) throw new Error('No decodable image in HEIF container')
    const width = image.get_width()
    const height = image.get_height()
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height }
    const result = await new Promise<RgbaImage | null>((resolve) => image.display(target, resolve))
    if (!result) throw new Error('HEIF pixel conversion failed')
    return { width, height, data: result.data }
  } finally {
    images.forEach((i) => i.free())
  }
}

export async function decodeHeic(blob: Blob): Promise<ImageBitmap> {
  const rgba = await decodeHeicToRgba(new Uint8Array(await blob.arrayBuffer()))
  return createImageBitmap(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height))
}
