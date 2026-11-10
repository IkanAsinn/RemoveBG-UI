// LOCAL /capabilities/detect (FR-11, FR-13, NFR-5). Every check is defensive: anything that throws counts as false.

import type { LoadOptions, ModelHandle } from './loader'

export interface Capabilities {
  webgl2: boolean
  wasmSimd: boolean
}

/**
 * Smallest module using a SIMD instruction: (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt).
 * Same bytes as the `wasm-feature-detect` SIMD probe; validating it compiles nothing and runs nothing.
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
])

type CanvasLike = { getContext(id: 'webgl2'): WebGL2RenderingContext | null }

export function detectWebGL2(createCanvas: () => CanvasLike = () => document.createElement('canvas')): boolean {
  try {
    const gl = createCanvas().getContext('webgl2')
    if (!gl || gl.isContextLost()) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext() // release the probe context right away
    return true
  } catch {
    return false
  }
}

export function detectWasmSimd(validate: (bytes: BufferSource) => boolean = (b) => WebAssembly.validate(b)): boolean {
  try {
    return typeof WebAssembly === 'object' && validate(SIMD_PROBE) === true
  } catch {
    return false
  }
}

export function detectCapabilities(deps: { createCanvas?: () => CanvasLike; validate?: (b: BufferSource) => boolean } = {}): Capabilities {
  return { webgl2: detectWebGL2(deps.createCanvas), wasmSimd: detectWasmSimd(deps.validate) }
}

/**
 * Backend choice once the PRD gate has passed: WebGPU when a GPU adapter is available (ORT's WebGL backend
 * cannot run ISNet), otherwise multi-threaded WASM.
 */
export async function detectWebGPU(gpu: { requestAdapter(): Promise<unknown> } | undefined = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu): Promise<boolean> {
  try {
    return !!gpu && (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

/** NFR-5: the full model may be fetched only when both checks pass. */
export const fullModelAllowed = (caps: Capabilities): boolean => caps.webgl2 && caps.wasmSimd

/** Orchestration entry point: never touches the network for the full model unless the device qualifies. */
export async function loadFullModelIfCapable(
  caps: Capabilities,
  load: (tier: 'full', opts?: LoadOptions) => Promise<ModelHandle>,
  opts?: LoadOptions,
): Promise<ModelHandle | null> {
  return fullModelAllowed(caps) ? load('full', opts) : null
}
