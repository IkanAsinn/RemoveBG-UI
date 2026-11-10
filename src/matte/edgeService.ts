import { applyEdge } from './edge'
import type { EdgeRequest, EdgeResponse } from './edge.worker'

/**
 * Latest-value-wins edge computation for one matte. At most one job is in flight; while it runs, newer slider
 * values replace each other and only the last one is computed next. `onResult` receives the matte for a value.
 */
export interface EdgeService {
  request(value: number): void
  dispose(): void
}

export function createEdgeService(
  base: Uint8ClampedArray,
  width: number,
  height: number,
  onResult: (value: number, mask: Uint8ClampedArray) => void,
): EdgeService {
  let worker: Worker | null = null
  try {
    if (typeof Worker !== 'undefined') {
      worker = new Worker(new URL('./edge.worker.ts', import.meta.url), { type: 'module' })
      worker.postMessage({ type: 'init', base: new Uint8ClampedArray(base), width, height } satisfies EdgeRequest)
    }
  } catch {
    worker = null
  }

  let busy = false
  let queued: number | null = null
  let nextId = 0
  let disposed = false

  const run = (value: number) => {
    busy = true
    if (worker) {
      worker.postMessage({ type: 'compute', id: ++nextId, value } satisfies EdgeRequest)
    } else {
      // No workers (tests, very old browsers): compute on a later task so input events are not blocked inline.
      setTimeout(() => finish(value, applyEdge(base, width, height, value)), 0)
    }
  }
  const finish = (value: number, mask: Uint8ClampedArray) => {
    busy = false
    if (disposed) return
    onResult(value, mask) // show progress during a drag, even if a newer value is already waiting
    const next = queued
    queued = null
    if (next !== null && next !== value) run(next)
  }
  if (worker) worker.onmessage = (e: MessageEvent<EdgeResponse>) => finish(e.data.value, e.data.mask)

  return {
    request(value) {
      if (disposed) return
      if (busy) queued = value
      else run(value)
    },
    dispose() {
      disposed = true
      worker?.terminate()
    },
  }
}
