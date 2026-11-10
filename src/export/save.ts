// LOCAL /file/save (FR-33). Saves one file under a suggested name.
//
// - File System Access API (Chromium desktop): a native save picker opens straight from the click, before anything is
//   rendered. Canceling it writes nothing. The file is written only after encoding succeeds.
// - Elsewhere: a normal browser download through a temporary object URL. The browser's own download UI handles it
//   from there. If the page is not allowed to start a download, the attempt throws and is reported as blocked.

import type { ExportFormat } from '../domain'
import { EXPORT_LABEL, EXPORT_MIME } from './encode'

export class SaveBlockedError extends Error {
  constructor() {
    super('The download was blocked by the browser')
    this.name = 'SaveBlockedError'
  }
}

export interface SaveTarget {
  /** Write the finished file. Throws SaveBlockedError when the browser refuses. */
  write(blob: Blob): Promise<void>
  /** Nothing will be written (render or encode failed): release the target without leaving a file behind. */
  discard(): Promise<void>
}

interface PickedFile {
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>
  getFile?: () => Promise<File>
  remove?: () => Promise<void>
}
type SavePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<PickedFile>
const savePicker = (): SavePicker | undefined => (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const isRefused = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')

/**
 * Choose where the file goes. Call it first thing in the click handler (the picker needs the user gesture).
 * Resolves to null when the user cancels the save picker.
 */
export async function openSaveTarget(fileName: string, format: ExportFormat): Promise<SaveTarget | null> {
  const picker = savePicker()
  if (typeof picker === 'function') {
    let handle: PickedFile
    try {
      const ext = `.${fileName.split('.').pop()}`
      handle = await picker({ suggestedName: fileName, types: [{ description: `${EXPORT_LABEL[format]} image`, accept: { [EXPORT_MIME[format]]: [ext] } }] })
    } catch (e) {
      if (isAbort(e)) return null
      if (isRefused(e)) throw new SaveBlockedError()
      // Picker unusable here (for example, inside a sandboxed frame): fall back to a normal download.
      return downloadTarget(fileName)
    }
    return {
      async write(blob) {
        try {
          const w = await handle.createWritable()
          await w.write(blob)
          await w.close()
        } catch (e) {
          throw isRefused(e) ? new SaveBlockedError() : e
        }
      },
      // Some browsers create the picked file (empty) as soon as it is chosen. Remove it only while it is still empty,
      // so a failed export leaves nothing behind but never deletes an existing file the user chose to replace.
      discard: async () => {
        try {
          if (handle.remove && handle.getFile && (await handle.getFile()).size === 0) await handle.remove()
        } catch {
          // best effort
        }
      },
    }
  }
  return downloadTarget(fileName)
}

function downloadTarget(fileName: string): SaveTarget {
  return {
    async write(blob) {
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        a.rel = 'noopener'
        a.style.display = 'none'
        document.body.append(a)
        a.click()
        a.remove()
      } catch {
        URL.revokeObjectURL(url)
        throw new SaveBlockedError()
      }
      // The download reads the URL asynchronously; release it once the browser has had time to start it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    discard: async () => {},
  }
}
