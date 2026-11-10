import { useCallback, useEffect, useState } from 'react'
import type { ModelTier } from '../domain'
import { loadModel, ModelLoadError, type ModelHandle } from './loader'

export type ModelState =
  | { status: 'loading'; progress: number }
  | { status: 'ready'; handle: ModelHandle }
  | { status: 'error'; error: ModelLoadError }

/** Loads a model tier on mount and exposes a retry; failures never touch the ingestion path (NFR-17). */
export function useModel(tier: ModelTier): { state: ModelState; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ModelState>({ status: 'loading', progress: 0 })

  useEffect(() => {
    let live = true
    setState({ status: 'loading', progress: 0 })
    loadModel(tier, {
      onProgress: (loaded, total) => live && setState({ status: 'loading', progress: total ? loaded / total : 0 }),
    })
      .then((handle) => live && setState({ status: 'ready', handle }))
      .catch((e) => {
        const error = e instanceof ModelLoadError ? e : new ModelLoadError(tier, 'init', String(e))
        if (live) setState({ status: 'error', error })
      })
    return () => {
      live = false
    }
  }, [tier, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry }
}
