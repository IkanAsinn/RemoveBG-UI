// Where a batch ZIP is streamed (OQ-8, OQ-9, FR-47, FR-48).
//
// 1. File System Access API (Chromium desktop: Chrome, Edge): a native save picker; bytes stream into the chosen
//    file through FileSystemWritableFileStream. Canceling the picker writes nothing. On failure the stream is
//    aborted, which discards everything written (the browser writes to a temporary file until close).
// 2. Fallback (Safari, Firefox, Chromium on Android): a same-origin service worker (public/zip-sw.js) answers a
//    hidden-iframe request with a streaming download response fed chunk by chunk, so the ZIP goes straight to the
//    browser's Downloads without being assembled in memory. On failure the response stream is errored and the
//    browser marks the download failed. Canceling the download in the browser stops the writer.
// 3. Neither available (e.g. service workers disabled in a private window): no ZIP is produced; the UI explains.
//    A whole-archive in-memory Blob is deliberately not used (FR-47).

import type { ZipSink } from './stream'

export type ZipSaveMethod = 'file-system' | 'download-stream' | 'unsupported'

export class ZipSaveCanceledError extends Error {
  constructor() {
    super('Save canceled')
    this.name = 'ZipSaveCanceledError'
  }
}

type SavePicker = (options: {
  suggestedName: string
  types: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<{ createWritable(): Promise<{ write(c: Uint8Array): Promise<void>; close(): Promise<void>; abort(r?: unknown): Promise<void> }> }>

const savePicker = (): SavePicker | undefined => (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker

export function zipSaveMethod(): ZipSaveMethod {
  if (typeof savePicker() === 'function') return 'file-system'
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof ReadableStream === 'function' && globalThis.isSecureContext) {
    return 'download-stream'
  }
  return 'unsupported'
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Open the destination for a ZIP. Must be called directly from the click handler (the save picker needs the user
 * gesture). Resolves to null when the user cancels the save picker.
 */
export async function openZipSink(filename: string): Promise<ZipSink | null> {
  const method = zipSaveMethod()
  if (method === 'file-system') {
    let handle
    try {
      handle = await savePicker()!({ suggestedName: filename, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] })
    } catch (e) {
      if (isAbort(e)) return null // FR-48: canceled, nothing written
      throw e
    }
    const writable = await handle.createWritable()
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: (reason) => writable.abort(reason),
    }
  }
  if (method === 'download-stream') return serviceWorkerSink(filename)
  throw new Error('This browser cannot stream a ZIP download')
}

const SW_URL = '/zip-sw.js'
const PREFIX = '/__zip-download/'

async function activeWorker(): Promise<ServiceWorker> {
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: '/' })
  const worker = reg.active ?? reg.waiting ?? reg.installing
  if (!worker) throw new Error('Service worker unavailable')
  if (worker.state === 'activated') return worker
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (worker.state === 'activated') resolve()
      else if (worker.state === 'redundant') reject(new Error('Service worker failed to activate'))
    }
    worker.addEventListener('statechange', check)
    check()
  })
  return worker
}

async function serviceWorkerSink(filename: string): Promise<ZipSink> {
  const worker = await activeWorker()
  const id = crypto.randomUUID()
  const { port1: port, port2 } = new MessageChannel()
  let credits = 0
  let canceled = false
  let waiter: (() => void) | null = null
  const wake = () => {
    waiter?.()
    waiter = null
  }
  const ready = new Promise<void>((resolve) => {
    port.onmessage = (e) => {
      const type = (e.data as { type: string }).type
      if (type === 'ready') resolve()
      else if (type === 'pull') credits++
      else if (type === 'cancel') canceled = true
      wake()
    }
  })
  worker.postMessage({ type: 'zip-download', id, filename }, [port2])
  await ready

  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.title = 'ZIP download'
  frame.src = `${PREFIX}${id}/${encodeURIComponent(filename)}`
  document.body.appendChild(frame)
  const keepAlive = setInterval(() => void fetch(`${PREFIX}ping`).catch(() => {}), 10_000)
  const finish = () => {
    clearInterval(keepAlive)
    setTimeout(() => frame.remove(), 60_000) // leave time for the browser to finish the download
    port.onmessage = null
  }

  return {
    async write(chunk) {
      while (credits === 0 && !canceled) await new Promise<void>((r) => (waiter = r))
      if (canceled) throw new ZipSaveCanceledError()
      credits--
      const copy = chunk.slice() // transfer a private buffer
      port.postMessage({ type: 'chunk', chunk: copy.buffer }, [copy.buffer])
    },
    async close() {
      port.postMessage({ type: 'close' })
      finish()
    },
    async abort() {
      port.postMessage({ type: 'abort' })
      finish()
    },
  }
}
