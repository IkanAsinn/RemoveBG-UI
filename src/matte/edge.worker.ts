/// <reference lib="webworker" />
// Runs the FR-19 edge transform off the main thread so the slider and brush stay responsive on phones.
import { applyEdge } from './edge'

export type EdgeRequest =
  | { type: 'init'; base: Uint8ClampedArray; width: number; height: number }
  | { type: 'compute'; id: number; value: number }
export type EdgeResponse = { type: 'result'; id: number; value: number; mask: Uint8ClampedArray }

let base: Uint8ClampedArray | null = null
let width = 0
let height = 0

self.onmessage = (e: MessageEvent<EdgeRequest>) => {
  const msg = e.data
  if (msg.type === 'init') {
    ;({ base, width, height } = msg)
    return
  }
  if (!base) return
  const out = applyEdge(base, width, height, msg.value)
  // Never transfer the worker's own copy of the base matte (returned as-is at the default value).
  const mask = out === base ? new Uint8ClampedArray(base) : out
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'result', id: msg.id, value: msg.value, mask } satisfies EdgeResponse, [mask.buffer])
}
