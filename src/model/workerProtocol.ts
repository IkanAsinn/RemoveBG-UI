// Messages between the page and src/model/inference.worker.ts.
import type { ModelBackend } from './loader'

export type WorkerRequest =
  | { type: 'create'; id: number; backend: ModelBackend; bytes: Uint8Array; threads: number }
  | { type: 'run'; id: number; input: Float32Array; dims: number[] }
  | { type: 'release' }

export type WorkerResponse =
  | { type: 'created'; id: number }
  | { type: 'ran'; id: number; output: Float32Array }
  | { type: 'error'; id: number; message: string }
  | { type: 'gpu-lost'; reason: string }
