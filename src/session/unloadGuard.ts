// FR-52: confirm before the tab is closed or reloaded while work would be lost. All session state lives in memory
// (FR-51), so leaving always discards it; the prompt only appears when something is in progress or unsaved.

import { useEffect } from 'react'

export interface UnloadGuardInput {
  /** Single image: decoding, background removal or the full-model upgrade is running. */
  singleProcessing: boolean
  /** Single image: the open image has edits (there is no saved copy of them anywhere). */
  singleEdited: boolean
  /** A batch is processing. */
  batchProcessing: boolean
  /** A batch ZIP is being written. */
  zipStreaming: boolean
  /** A batch has edits not yet included in a saved ZIP, or a batch item is open with edits. */
  batchUnsavedEdits: boolean
}

export const needsUnloadConfirmation = (input: UnloadGuardInput): boolean => Object.values(input).some(Boolean)

/** Registers the browser's native leave-page confirmation while `active`. */
export function useBeforeUnload(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // older browsers need returnValue set to show the prompt
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active])
}
