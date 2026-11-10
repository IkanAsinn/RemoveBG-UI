// Model choice for batch runs: tiny is required; full when the device passes the PRD gate (WebGL2 + WASM SIMD).
// Handles come from the shared loader cache, so a model already loaded by the single-image flow is reused.

import { detectCapabilities, detectWebGPU, fullModelAllowed } from '../model/capabilities'
import { evictModel, loadModel } from '../model/loader'
import type { BatchDeps } from './process'

export function defaultBatchDeps(): BatchDeps {
  return {
    loadTiny: () => loadModel('tiny'),
    loadFull: async () => {
      if (!fullModelAllowed(detectCapabilities())) return null // NFR-5: never fetched on devices that fail the gate
      return loadModel('full', { backend: (await detectWebGPU()) ? 'webgpu' : 'wasm' })
    },
    onFullFailed: (handle) => {
      if (handle) evictModel('full', handle.backend)
    },
  }
}
