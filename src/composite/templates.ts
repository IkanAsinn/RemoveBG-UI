// LOCAL /composite/templates (FR-28, FR-54). Bundled background templates: the manifest is compiled into the app and
// every asset is a same-origin file under /templates/, so nothing is fetched from a CDN at runtime. Plain HTTP
// caching of those files is fine (NFR-2); decoded images live only in this tab's memory.
// Sources: assets-src/templates/*.svg, rasterized to 2400 × 1600 WebP plus 240 × 160 thumbnails.

import type { TemplateAsset } from '../domain'

const T = (id: string, name: string): TemplateAsset => ({ id, name, assetUrl: `/templates/${id}.webp`, width: 2400, height: 1600 })

export const TEMPLATES: readonly TemplateAsset[] = [
  T('studio-light', 'Studio light'),
  T('studio-warm', 'Studio warm'),
  T('pastel-blobs', 'Pastel blobs'),
  T('bokeh-night', 'Bokeh night'),
  T('geometric-coral', 'Geometric coral'),
  T('sky-clouds', 'Sky and clouds'),
  T('mint-arches', 'Mint arches'),
  T('grid-paper', 'Grid paper'),
]

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id)
export const templateThumbUrl = (t: TemplateAsset) => t.assetUrl.replace('/templates/', '/templates/thumbs/')

/** Decode an image URL with the browser's image loader (same-origin GET). Swappable in tests. */
export type ImageLoader = (url: string) => Promise<CanvasImageSource & { width: number; height: number }>
const browserLoader: ImageLoader = async (url) => {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  await img.decode()
  return createImageBitmap(img)
}

const pending = new Map<string, Promise<CanvasImageSource>>()
const ready = new Map<string, CanvasImageSource>()

/**
 * Load and decode a template once per tab. A failure is not cached, so calling again retries the request.
 * Throws for an unknown id or when the asset cannot be loaded.
 */
export function loadTemplate(id: string, load: ImageLoader = browserLoader): Promise<CanvasImageSource> {
  const hit = pending.get(id)
  if (hit) return hit
  const t = templateById(id)
  if (!t) return Promise.reject(new Error(`Unknown template ${id}`))
  const p = load(t.assetUrl).then(
    (img) => {
      ready.set(id, img)
      return img
    },
    (err) => {
      pending.delete(id)
      throw err
    },
  )
  pending.set(id, p)
  return p
}

/** Synchronous resolver for drawBackground: the decoded template, or null while it is not loaded. */
export const bundledTemplate = (id: string): CanvasImageSource | null => ready.get(id) ?? null

/** Test helper: forget every loaded template. */
export function resetTemplateCache() {
  pending.clear()
  ready.clear()
}
