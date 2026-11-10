// Full-model upgrade (FR-11–FR-14, NFR-5). Runs only after the tiny cutout is on screen.

import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionStore, type CutoutResult, type SourceImage } from '../domain'
import { detectCapabilities, detectWebGPU, fullModelAllowed, type Capabilities } from '../model/capabilities'
import { evictModel, GpuLostError, loadModel, type ModelBackend } from '../model/loader'
import { removeBackground } from './remove'

export type UpgradeState =
  | { status: 'idle' }
  | { status: 'skipped'; caps: Capabilities } // FR-13: device failed the gate; full model never fetched
  | { status: 'loading'; progress: number }
  | { status: 'running' }
  | { status: 'done' }
  | { status: 'failed' } // FR-14: fetch/init/run failed
  | { status: 'interrupted' } // GPU lost mid-run

export interface UpgradeDeps {
  detect?: () => Capabilities
  pickBackend?: () => Promise<ModelBackend>
}

const defaultPickBackend = async (): Promise<ModelBackend> => ((await detectWebGPU()) ? 'webgpu' : 'wasm')

export function useFullUpgrade(image: SourceImage | undefined, tinyCutout: CutoutResult | undefined, deps: UpgradeDeps = {}) {
  const [state, setState] = useState<UpgradeState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const startedFor = useRef<string | null>(null) // `${imageId}:${attempt}` — one run per image per attempt
  const forceWasm = useRef(false) // after a GPU loss, retry on the CPU path
  const depsRef = useRef(deps)
  depsRef.current = deps

  // A new image starts from scratch.
  useEffect(() => {
    setState({ status: 'idle' })
  }, [image?.id])

  useEffect(() => {
    if (!image || tinyCutout?.status !== 'ready' || tinyCutout.modelTier !== 'tiny') return
    const key = `${image.id}:${attempt}`
    if (startedFor.current === key) return
    startedFor.current = key
    const stillCurrent = () => startedFor.current === key

    void (async () => {
      // FR-11: capability check after the tiny result is displayed.
      const caps = (depsRef.current.detect ?? detectCapabilities)()
      if (!fullModelAllowed(caps)) {
        setState({ status: 'skipped', caps }) // FR-13 / NFR-5: no fetch at all
        return
      }
      const backend = forceWasm.current ? 'wasm' : await (depsRef.current.pickBackend ?? defaultPickBackend)()
      try {
        setState({ status: 'loading', progress: 0 })
        const handle = await loadModel('full', {
          backend,
          onProgress: (loaded, total) => stillCurrent() && setState({ status: 'loading', progress: loaded / total }),
        })
        if (!stillCurrent()) return
        setState({ status: 'running' })
        const lost = handle.gpuLost?.then((reason) => Promise.reject(new GpuLostError(reason)))
        const full = await (lost ? Promise.race([removeBackground(handle, image), lost]) : removeBackground(handle, image))
        // FR-12: replace the tiny result, unless the user moved on meanwhile.
        if (!stillCurrent() || !sessionStore.getState().sourceImages[image.id]) {
          full.cutoutBitmap.close()
          return
        }
        sessionStore.create('cutouts', full)
        if (sessionStore.getState().cutouts[tinyCutout.id]) sessionStore.remove('cutouts', tinyCutout.id)
        setState({ status: 'done' })
      } catch (e) {
        if (e instanceof GpuLostError) {
          evictModel('full', backend)
          forceWasm.current = true
        }
        // The tiny cutout is never touched on failure (FR-14).
        if (stillCurrent()) setState({ status: e instanceof GpuLostError ? 'interrupted' : 'failed' })
      }
    })()
  }, [image, tinyCutout, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry }
}
