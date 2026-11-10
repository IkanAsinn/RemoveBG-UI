// Streaming download fallback for browsers without the File System Access API (Safari, Firefox): OQ-9.
//
// The page hands this worker a MessagePort and then opens /__zip-download/<id>/<name> in a hidden iframe. The
// worker answers that request with a ReadableStream that is fed from the port, so the browser writes the ZIP to
// the Downloads folder as it is produced; the archive never exists in memory as a whole (FR-47).
// Backpressure: the stream asks for data (pull → "pull" message) and the page sends one chunk per request, so at
// most about one writer chunk (<= 4 MB, NFR-8) is in flight. An abort errors the stream, so the browser marks the
// download failed instead of complete (FR-49). Same-origin only; no third-party code.

const PREFIX = '/__zip-download/'
const pending = new Map()

self.addEventListener('install', () => self.skipWaiting())
// Claim open pages without holding activation on it: Firefox can leave the worker in 'activating' while a page with
// a busy dedicated worker is claimed, and the download iframe only needs an activated worker, not a controlled page.
self.addEventListener('activate', () => {
  self.clients.claim().catch(() => {})
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'zip-download' || !event.ports[0]) return
  const port = event.ports[0]
  let controller
  const stream = new ReadableStream(
    {
      start(c) {
        controller = c
      },
      pull() {
        port.postMessage({ type: 'pull' })
      },
      cancel() {
        // The user canceled the download in the browser UI.
        port.postMessage({ type: 'cancel' })
        pending.delete(data.id)
      },
    },
    { highWaterMark: 1 },
  )
  port.onmessage = (msg) => {
    const m = msg.data
    if (m.type === 'chunk') controller.enqueue(new Uint8Array(m.chunk))
    else if (m.type === 'close') controller.close()
    else if (m.type === 'abort') controller.error(new Error('ZIP download was incomplete'))
  }
  pending.set(data.id, { stream, filename: data.filename })
  port.postMessage({ type: 'ready' })
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  const rest = url.pathname.slice(PREFIX.length)
  if (rest === 'ping') {
    // Keep-alive while a download streams (some browsers stop idle workers).
    event.respondWith(new Response(null, { status: 204 }))
    return
  }
  const id = rest.split('/')[0]
  const entry = pending.get(id)
  if (!entry) {
    event.respondWith(new Response('Download expired', { status: 404 }))
    return
  }
  pending.delete(id)
  const name = entry.filename.replace(/["\\\r\n]/g, '_')
  event.respondWith(
    new Response(entry.stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    }),
  )
})
