// Clipboard image access (FR-3, FR-4, OQ-7 fallback).

export const NO_IMAGE_MESSAGE = 'No image found on the clipboard.'
export const UNAVAILABLE_MESSAGE = 'Clipboard image paste is not available in this browser. Use upload instead.'

/** FR-3: pastes typed into text fields are the user's text, not an image ingest. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'file', 'range', 'color', 'submit', 'reset', 'image'].includes(target.type)
  return false
}

/** First image file carried by a paste event, or null. */
export function imageFromPasteEvent(data: DataTransfer | null): File | null {
  if (!data) return null
  const fromFiles = Array.from(data.files ?? []).find((f) => f.type.startsWith('image/'))
  if (fromFiles) return fromFiles
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) return f
    }
  }
  return null
}

export type ClipboardReadResult = { kind: 'image'; blob: Blob } | { kind: 'empty' } | { kind: 'unavailable' }

/** Paste button path: async Clipboard API. Denied permission or a missing API maps to 'unavailable'. */
export async function readClipboardImage(): Promise<ClipboardReadResult> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return { kind: 'unavailable' }
  }
  let items: ClipboardItems
  try {
    items = await navigator.clipboard.read()
  } catch (e) {
    // Some browsers throw DataError when the clipboard is empty or holds nothing readable.
    if (e instanceof DOMException && e.name === 'DataError') return { kind: 'empty' }
    return { kind: 'unavailable' }
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (type) {
      try {
        return { kind: 'image', blob: await item.getType(type) }
      } catch {
        return { kind: 'unavailable' }
      }
    }
  }
  return { kind: 'empty' }
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
export const clipboardFileName = (type: string): string => `pasted-image.${EXT[type] ?? 'png'}`
