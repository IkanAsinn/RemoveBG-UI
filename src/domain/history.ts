// FR-22 / FR-23 undo-redo. Records are EditState deltas only (never pixels), kept in memory per EditState id.
// This is deliberately not a Data Model entity (the PRD has no History entity) and is never persisted (NG2): it
// lives for the tab's lifetime, independent of which panel or component is mounted.

import { EDGE_VALUE_DEFAULT, type BrushStroke, type CropRect, type EditState } from './types'

export type EditSnapshot = Pick<EditState, 'strokes' | 'edgeValue' | 'crop'>

export type EditDelta =
  | { kind: 'stroke'; stroke: BrushStroke }
  | { kind: 'edge'; from: number; to: number }
  | { kind: 'crop'; from: CropRect | null; to: CropRect | null }
  | { kind: 'reset'; before: EditSnapshot }

/** Kept per image; FR-22 requires at least 20. */
export const HISTORY_LIMIT = 50

/** The EditState patch that applies (`redo`) or reverts (`undo`) a delta on top of `edit`. */
export function deltaPatch(edit: EditSnapshot, delta: EditDelta, direction: 'undo' | 'redo'): Partial<EditSnapshot> {
  const forward = direction === 'redo'
  switch (delta.kind) {
    case 'stroke': {
      if (forward) return { strokes: [...edit.strokes, delta.stroke] }
      const i = edit.strokes.lastIndexOf(delta.stroke)
      return { strokes: i < 0 ? edit.strokes : [...edit.strokes.slice(0, i), ...edit.strokes.slice(i + 1)] }
    }
    case 'edge':
      return { edgeValue: forward ? delta.to : delta.from }
    case 'crop':
      return { crop: forward ? delta.to : delta.from }
    case 'reset':
      return forward ? { strokes: [], edgeValue: EDGE_VALUE_DEFAULT, crop: null } : { ...delta.before }
  }
}

interface Stacks {
  undo: EditDelta[]
  redo: EditDelta[]
}

export function createHistory(limit = HISTORY_LIMIT) {
  const stacks = new Map<string, Stacks>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = () => {
    version++
    for (const l of listeners) l()
  }
  const get = (id: string) => {
    let s = stacks.get(id)
    if (!s) stacks.set(id, (s = { undo: [], redo: [] }))
    return s
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Changes whenever any stack changes (for useSyncExternalStore). */
    getVersion: () => version,

    /** Record a change the user just made. A new change clears the redo stack. */
    push(editId: string, delta: EditDelta) {
      const s = get(editId)
      s.undo.push(delta)
      if (s.undo.length > limit) s.undo.splice(0, s.undo.length - limit)
      s.redo = []
      emit()
    },
    canUndo: (editId: string) => (stacks.get(editId)?.undo.length ?? 0) > 0,
    canRedo: (editId: string) => (stacks.get(editId)?.redo.length ?? 0) > 0,
    depth: (editId: string) => ({ undo: stacks.get(editId)?.undo.length ?? 0, redo: stacks.get(editId)?.redo.length ?? 0 }),

    /** Pop one step and return the patch to apply to the EditState, or null at the boundary. */
    undo(editId: string, edit: EditSnapshot): Partial<EditSnapshot> | null {
      const s = stacks.get(editId)
      const delta = s?.undo.pop()
      if (!s || !delta) return null
      s.redo.push(delta)
      emit()
      return deltaPatch(edit, delta, 'undo')
    },
    redo(editId: string, edit: EditSnapshot): Partial<EditSnapshot> | null {
      const s = stacks.get(editId)
      const delta = s?.redo.pop()
      if (!s || !delta) return null
      s.undo.push(delta)
      emit()
      return deltaPatch(edit, delta, 'redo')
    },

    /** Forget an image's history (image discarded or session reset). */
    clear(editId?: string) {
      if (editId === undefined) stacks.clear()
      else stacks.delete(editId)
      emit()
    },
  }
}

export type EditHistory = ReturnType<typeof createHistory>

/** The session's edit history: memory only, gone when the tab closes. */
export const editHistory = createHistory()
