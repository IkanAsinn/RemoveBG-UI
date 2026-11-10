import { describe, expect, it, vi } from 'vitest'
import { detectCapabilities, detectWasmSimd, detectWebGL2, detectWebGPU, fullModelAllowed, loadFullModelIfCapable } from './capabilities'
import type { ModelHandle } from './loader'

const glContext = (lost = false) =>
  ({ isContextLost: () => lost, getExtension: () => ({ loseContext: vi.fn() }) }) as unknown as WebGL2RenderingContext
const canvasReturning = (ctx: WebGL2RenderingContext | null) => () => ({ getContext: () => ctx })

describe('detectWebGL2', () => {
  it('is true when a live webgl2 context is created, and releases it', () => {
    const lose = vi.fn()
    const ctx = { isContextLost: () => false, getExtension: () => ({ loseContext: lose }) } as unknown as WebGL2RenderingContext
    expect(detectWebGL2(canvasReturning(ctx))).toBe(true)
    expect(lose).toHaveBeenCalled()
  })
  it.each([
    ['context creation returns null', canvasReturning(null)],
    ['context is already lost', canvasReturning(glContext(true))],
    ['getContext throws', () => ({ getContext: () => { throw new Error('GPU process crashed') } })],
    ['canvas creation throws', () => { throw new Error('no DOM') }],
  ])('forced failure (%s) → false, no throw', (_l, createCanvas) => {
    expect(() => detectWebGL2(createCanvas)).not.toThrow()
    expect(detectWebGL2(createCanvas)).toBe(false)
  })
})

describe('detectWasmSimd', () => {
  it('validates the real SIMD probe module with the runtime WebAssembly engine', () => {
    expect(detectWasmSimd()).toBe(true) // Node 24's V8 supports SIMD
  })
  it.each([
    ['validator rejects the module', () => false],
    ['validator throws', () => { throw new Error('boom') }],
  ])('forced SIMD failure (%s) → false, no throw', (_l, validate) => {
    expect(detectWasmSimd(validate)).toBe(false)
  })
})

describe('detectCapabilities (LOCAL /capabilities/detect)', () => {
  it('returns booleans and never throws, even when every probe throws', () => {
    const boom = () => { throw new Error('x') }
    const caps = detectCapabilities({ createCanvas: boom, validate: boom })
    expect(caps).toEqual({ webgl2: false, wasmSimd: false })
  })
})

describe('full-model gate (NFR-5)', () => {
  const handle = { tier: 'full' } as ModelHandle
  it.each([
    [{ webgl2: true, wasmSimd: true }, true],
    [{ webgl2: false, wasmSimd: true }, false],
    [{ webgl2: true, wasmSimd: false }, false],
    [{ webgl2: false, wasmSimd: false }, false],
  ])('%o → fetch allowed: %s', async (caps, allowed) => {
    const load = vi.fn(async () => handle)
    expect(fullModelAllowed(caps)).toBe(allowed)
    expect(await loadFullModelIfCapable(caps, load)).toBe(allowed ? handle : null)
    expect(load).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })
})

describe('detectWebGPU (backend choice after the gate)', () => {
  type Gpu = { requestAdapter(): Promise<unknown> } | undefined
  const cases: Array<[string, Gpu, boolean]> = [
    ['adapter available', { requestAdapter: async (): Promise<unknown> => ({}) }, true],
    ['no adapter', { requestAdapter: async (): Promise<unknown> => null }, false],
    ['requestAdapter throws', { requestAdapter: async (): Promise<unknown> => Promise.reject(new Error('blocked')) }, false],
    ['no navigator.gpu', undefined, false],
  ]
  it.each(cases)('%s → %s', async (_l, gpu, expected) => {
    expect(await detectWebGPU(gpu)).toBe(expected)
  })
})
