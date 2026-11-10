// In-memory session store (FR-51, NFR-2). State lives in this module only; it never touches
// localStorage, sessionStorage, IndexedDB, cookies, or the Cache API, so it is gone when the tab closes.

import { createBackgroundSelection } from './factories'
import type { BackgroundSelection, BatchJob, CutoutResult, EditState, SourceImage } from './types'

export interface SessionState {
  sourceImages: Record<string, SourceImage>
  cutouts: Record<string, CutoutResult>
  editStates: Record<string, EditState>
  batchJobs: Record<string, BatchJob>
  background: BackgroundSelection
}

export type EntityCollection = 'sourceImages' | 'cutouts' | 'editStates' | 'batchJobs'
type EntityOf<C extends EntityCollection> = SessionState[C][string]

export const emptySession = (): SessionState => ({
  sourceImages: {},
  cutouts: {},
  editStates: {},
  batchJobs: {},
  background: createBackgroundSelection(),
})

/** Free GPU/decoder memory held by bitmaps when entities leave the session. */
function closeBitmaps(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const v of Object.values(value)) {
    if (v && typeof (v as ImageBitmap).close === 'function') (v as ImageBitmap).close()
  }
}

export function createSessionStore() {
  let state = emptySession()
  const listeners = new Set<() => void>()

  const commit = (next: SessionState) => {
    state = next
    listeners.forEach((l) => l())
  }

  return {
    getState: (): SessionState => state,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    create<C extends EntityCollection>(collection: C, entity: EntityOf<C>): EntityOf<C> {
      if (state[collection][entity.id]) throw new Error(`${collection}: id ${entity.id} already exists`)
      commit({ ...state, [collection]: { ...state[collection], [entity.id]: entity } })
      return entity
    },

    update<C extends EntityCollection>(collection: C, id: string, patch: Partial<EntityOf<C>>): EntityOf<C> {
      const current = state[collection][id] as EntityOf<C> | undefined
      if (!current) throw new Error(`${collection}: id ${id} not found`)
      const next = { ...current, ...patch, id } as EntityOf<C>
      commit({ ...state, [collection]: { ...state[collection], [id]: next } })
      return next
    },

    remove(collection: EntityCollection, id: string): boolean {
      const current = state[collection][id]
      if (!current) return false
      const { [id]: _removed, ...rest } = state[collection]
      closeBitmaps(current)
      commit({ ...state, [collection]: rest })
      return true
    },

    setBackground(background: BackgroundSelection): void {
      if (state.background.imageBitmap && state.background.imageBitmap !== background.imageBitmap) {
        state.background.imageBitmap.close()
      }
      commit({ ...state, background })
    },

    /** LOCAL /session/reset — clears every in-memory session entity. */
    reset(): SessionState {
      for (const c of ['sourceImages', 'cutouts', 'editStates'] as const) Object.values(state[c]).forEach(closeBitmaps)
      closeBitmaps(state.background)
      commit(emptySession())
      return state
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>

/** The app-wide session store. */
export const sessionStore = createSessionStore()

/** LOCAL /session/reset contract: clears all in-memory session entities and returns the empty session. */
export const sessionReset = (store: SessionStore = sessionStore): SessionState => store.reset()
