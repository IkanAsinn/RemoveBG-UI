// LOCAL /model/load (FR-10 loading contract, FR-15, NFR-17, NFR-18).
// Model requests are plain same-origin GETs with no body and no query string, so no image data can ride along.

import type { ModelTier } from '../domain'
import { MODEL_MANIFEST, modelUrl, type ModelInfo } from './manifest'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

export type ModelBackend = 'wasm' | 'webgpu'
export type ModelLoadErrorKind = 'fetch' | 'timeout' | 'corrupt' | 'init'

export class ModelLoadError extends Error {
  readonly kind: ModelLoadErrorKind
  readonly tier: ModelTier
  constructor(tier: ModelTier, kind: ModelLoadErrorKind, detail: string) {
    super(`${tier} model ${kind} error: ${detail}`)
    this.name = 'ModelLoadError'
    this.tier = tier
    this.kind = kind
  }
}

/** The GPU device behind a WebGPU session was lost (the WebGPU analogue of WebGL context loss). */
export class GpuLostError extends Error {
  constructor(reason: string) {
    super(`GPU device lost: ${reason}`)
    this.name = 'GpuLostError'
  }
}

/** A loaded model: takes the NCHW input tensor data and returns the first output's data. */
export interface MattingSession {
  run(input: Float32Array, dims: number[]): Promise<Float32Array>
  release(): void
}

export interface ModelHandle {
  tier: ModelTier
  info: ModelInfo
  backend: ModelBackend
  session: MattingSession
  /** WebGPU only: resolves (with a reason) if the GPU device is lost — the WebGPU analogue of WebGL context loss. */
  gpuLost?: Promise<string>
}

export type SessionFactory = (bytes: Uint8Array, backend: ModelBackend) => Promise<{ session: MattingSession; gpuLost?: Promise<string> }>

export interface LoadOptions {
  backend?: ModelBackend
  /** Abort if no bytes arrive for this long. Slow-but-progressing downloads are allowed (NFR-4: no load budget). */
  stallTimeoutMs?: number
  onProgress?: (loaded: number, total: number) => void
  fetchImpl?: typeof fetch
  createSession?: SessionFactory
}

/** Threads need SharedArrayBuffer, i.e. a cross-origin-isolated page (COOP/COEP headers). */
const wasmThreads = () => (globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1)

/**
 * Each model runs in its own module worker (src/model/inference.worker.ts) that lazily loads the same-origin
 * ORT bundle for its backend. The page never blocks on inference.
 */
export const createOrtSession: SessionFactory = (bytes, backend) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' })
    const pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>()
    let nextId = 1
    let onGpuLost: (reason: string) => void = () => {}
    const gpuLost = backend === 'webgpu' ? new Promise<string>((r) => (onGpuLost = r)) : undefined
    const send = (msg: WorkerRequest, transfer: Transferable[] = []) => worker.postMessage(msg, transfer)

    const session: MattingSession = {
      run: (input, dims) =>
        new Promise((res, rej) => {
          const id = nextId++
          pending.set(id, { resolve: res, reject: rej })
          send({ type: 'run', id, input, dims }, [input.buffer])
        }),
      release: () => {
        send({ type: 'release' })
        worker.terminate()
      },
    }

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'created') resolve({ session, gpuLost })
      else if (msg.type === 'ran') pending.get(msg.id)?.resolve(msg.output)
      else if (msg.type === 'gpu-lost') {
        onGpuLost(msg.reason)
        pending.forEach((p) => p.reject(new GpuLostError(msg.reason)))
        pending.clear()
      } else if (msg.type === 'error') {
        if (msg.id === 0) {
          worker.terminate()
          reject(new Error(msg.message))
        } else pending.get(msg.id)?.reject(new Error(msg.message))
      }
      if ('id' in msg) pending.delete(msg.id)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'Inference worker failed to start'))
    }
    send({ type: 'create', id: 0, backend, bytes, threads: wasmThreads() }, [bytes.buffer])
  })

async function download(tier: ModelTier, info: ModelInfo, opts: Required<Pick<LoadOptions, 'stallTimeoutMs' | 'fetchImpl'>> & LoadOptions) {
  const controller = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, opts.stallTimeoutMs)
  }

  try {
    arm()
    let res: Response
    try {
      res = await opts.fetchImpl(modelUrl(tier), { method: 'GET', credentials: 'same-origin', signal: controller.signal })
    } catch (e) {
      throw new ModelLoadError(tier, stalled ? 'timeout' : 'fetch', String(e))
    }
    if (!res.ok) throw new ModelLoadError(tier, 'fetch', `HTTP ${res.status}`)

    // Stream straight into one buffer of the manifest size: a 178 MB model must not be held twice on a phone.
    const bytes = new Uint8Array(info.bytes)
    let loaded = 0
    const append = (chunk: Uint8Array) => {
      if (loaded + chunk.byteLength > info.bytes) throw new ModelLoadError(tier, 'corrupt', `more than the expected ${info.bytes} bytes`)
      bytes.set(chunk, loaded)
      loaded += chunk.byteLength
      opts.onProgress?.(loaded, info.bytes)
    }
    try {
      if (res.body) {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          arm()
          append(value)
        }
      } else {
        append(new Uint8Array(await res.arrayBuffer()))
      }
    } catch (e) {
      if (e instanceof ModelLoadError) throw e
      throw new ModelLoadError(tier, stalled ? 'timeout' : 'fetch', String(e))
    }

    if (loaded !== info.bytes) throw new ModelLoadError(tier, 'corrupt', `received ${loaded} bytes, expected ${info.bytes}`)
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
    if (digest !== info.sha256) throw new ModelLoadError(tier, 'corrupt', 'sha256 mismatch')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

const cache = new Map<string, Promise<ModelHandle>>()

/** Load a tier. Concurrent and repeat calls share one load; a failure is evicted so the caller can retry. */
export function loadModel(tier: ModelTier, options: LoadOptions = {}): Promise<ModelHandle> {
  const backend = options.backend ?? 'wasm'
  const key = `${tier}:${backend}`
  const existing = cache.get(key)
  if (existing) return existing

  const info = MODEL_MANIFEST[tier]
  const opts = { stallTimeoutMs: 30_000, fetchImpl: fetch.bind(globalThis), ...options }
  const promise = (async () => {
    const bytes = await download(tier, info, opts)
    try {
      const { session, gpuLost } = await (opts.createSession ?? createOrtSession)(bytes, backend)
      return { tier, info, backend, session, gpuLost }
    } catch (e) {
      throw new ModelLoadError(tier, 'init', e instanceof Error ? e.message : String(e))
    }
  })()
  cache.set(key, promise)
  promise.catch(() => cache.delete(key))
  return promise
}

/** Forget one loaded model (e.g. after its GPU device was lost) so the next load starts fresh. */
export function evictModel(tier: ModelTier, backend: ModelBackend): void {
  cache.delete(`${tier}:${backend}`)
}

/** Drop all cached handles (tests). */
export function clearModelCache(): void {
  cache.clear()
}
