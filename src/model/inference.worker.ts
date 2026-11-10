/// <reference lib="webworker" />
// Runs ONNX Runtime off the main thread so the page stays responsive during multi-second inference.
// One worker per loaded model. Only model bytes and tensor data cross the boundary (no network access here).

import type { InferenceSession } from 'onnxruntime-web'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

declare const self: DedicatedWorkerGlobalScope

let session: InferenceSession | null = null
let ort: typeof import('onnxruntime-web/wasm') | typeof import('onnxruntime-web/webgpu') | null = null

const reply = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'create') {
      ort = msg.backend === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')
      ort.env.wasm.numThreads = msg.threads
      session = await ort.InferenceSession.create(msg.bytes, { executionProviders: [msg.backend], graphOptimizationLevel: 'all' })
      if (msg.backend === 'webgpu') {
        // WebGPU's equivalent of WebGL context loss: tell the page so it can keep the tiny result and offer a retry.
        const device = (await ort.env.webgpu.device) as unknown as { lost: Promise<{ reason: string; message: string }> }
        void device.lost.then((info) => reply({ type: 'gpu-lost', reason: info.message || info.reason || 'GPU device lost' }))
      }
      reply({ type: 'created', id: msg.id })
    } else if (msg.type === 'run') {
      if (!session || !ort) throw new Error('Session not created')
      const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', msg.input, msg.dims) }
      const results = await session.run(feeds)
      const out = results[session.outputNames[0]]
      const data = (out.location === 'cpu' ? out.data : await out.getData()) as Float32Array
      const copy = new Float32Array(data) // own buffer so it can be transferred
      Object.values(results).forEach((t) => t.dispose())
      reply({ type: 'ran', id: msg.id, output: copy }, [copy.buffer])
    } else if (msg.type === 'release') {
      await session?.release()
      session = null
    }
  } catch (err) {
    reply({ type: 'error', id: 'id' in msg ? msg.id : -1, message: err instanceof Error ? err.message : String(err) })
  }
}
