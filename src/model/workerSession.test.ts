import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrtSession, GpuLostError } from './loader'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

/** Stand-in for the inference worker: records requests and lets the test reply. */
class FakeWorker {
  static last: FakeWorker
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  sent: WorkerRequest[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  postMessage(msg: WorkerRequest) {
    this.sent.push(msg)
  }
  terminate() {
    this.terminated = true
  }
  reply(msg: WorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>)
  }
}

beforeEach(() => vi.stubGlobal('Worker', FakeWorker))
afterEach(() => vi.unstubAllGlobals())

describe('worker-backed MattingSession', () => {
  it('creates a session, runs inference in the worker, and returns the output', async () => {
    const pending = createOrtSession(new Uint8Array([1, 2, 3]), 'wasm')
    const w = FakeWorker.last
    expect(w.sent[0]).toMatchObject({ type: 'create', backend: 'wasm' })
    w.reply({ type: 'created', id: 0 })
    const { session, gpuLost } = await pending
    expect(gpuLost).toBeUndefined() // only WebGPU sessions can lose a device

    const run = session.run(new Float32Array(4), [1, 1, 2, 2])
    const req = w.sent[1] as Extract<WorkerRequest, { type: 'run' }>
    expect(req).toMatchObject({ type: 'run', dims: [1, 1, 2, 2] })
    w.reply({ type: 'ran', id: req.id, output: new Float32Array([0.5]) })
    expect(Array.from(await run)).toEqual([0.5])
  })

  it('GPU loss rejects the in-flight run with GpuLostError and resolves gpuLost', async () => {
    const pending = createOrtSession(new Uint8Array([1]), 'webgpu')
    const w = FakeWorker.last
    w.reply({ type: 'created', id: 0 })
    const { session, gpuLost } = await pending
    const run = session.run(new Float32Array(4), [1, 1, 2, 2])

    w.reply({ type: 'gpu-lost', reason: 'destroyed' })
    await expect(run).rejects.toBeInstanceOf(GpuLostError) // typed, so the UI shows "Full model interrupted."
    await expect(gpuLost).resolves.toBe('destroyed')
  })

  it('a session-creation error rejects and terminates the worker', async () => {
    const pending = createOrtSession(new Uint8Array([1]), 'webgpu')
    FakeWorker.last.reply({ type: 'error', id: 0, message: 'unsupported op' })
    await expect(pending).rejects.toThrow('unsupported op')
    expect(FakeWorker.last.terminated).toBe(true)
  })
})
