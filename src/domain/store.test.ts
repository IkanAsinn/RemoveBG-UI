import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BATCH_ITEM_STATUSES,
  createBackgroundSelection,
  createBatchItem,
  createBatchJob,
  createCutoutResult,
  createEditState,
  createSessionStore,
  createSourceImage,
  emptySession,
  sessionReset,
  type SessionStore,
} from './index'

const fakeBitmap = () => ({ width: 4, height: 3, close: vi.fn() }) as unknown as ImageBitmap

function populate(store: SessionStore) {
  const img = store.create(
    'sourceImages',
    createSourceImage({
      fileName: 'cat.png',
      mimeType: 'image/png',
      byteSize: 10,
      width: 4,
      height: 3,
      sourceKind: 'upload',
      originalBlob: new Blob(['x']),
      decodedBitmap: fakeBitmap(),
      decodePath: 'native',
    }),
  )
  const cut = store.create(
    'cutouts',
    createCutoutResult({ sourceImageId: img.id, modelTier: 'tiny', cutoutBitmap: fakeBitmap(), alphaMask: new Uint8ClampedArray(12) }),
  )
  const edit = store.create('editStates', createEditState(cut.id))
  const item = createBatchItem(img.id, { cutoutId: cut.id, editStateId: edit.id })
  const job = store.create('batchJobs', createBatchJob([item], 10))
  store.setBackground(createBackgroundSelection({ type: 'solid', color: '#ff0000' }))
  return { img, cut, edit, job }
}

describe('factories', () => {
  it('apply PRD defaults and ranges', () => {
    const e = createEditState('c1', { brushRadius: 999, edgeValue: -5 })
    expect(e).toMatchObject({ cutoutId: 'c1', brushMode: 'erase', brushRadius: 200, edgeValue: 0, strokes: [], crop: null })
    expect(createEditState('c1').edgeValue).toBe(50)
    expect(createBackgroundSelection().type).toBe('transparent')
    expect(createBatchItem('s1')).toMatchObject({ status: 'queued', edited: false, cutoutId: null })
    expect(BATCH_ITEM_STATUSES).toEqual(['queued', 'processing', 'done', 'failed'])
  })
})

describe('session store', () => {
  it('creates, updates, and removes entities', () => {
    const store = createSessionStore()
    const { img, cut, edit, job } = populate(store)
    const s = store.getState()
    expect(s.sourceImages[img.id].fileName).toBe('cat.png')
    expect(s.cutouts[cut.id].sourceImageId).toBe(img.id)
    expect(s.editStates[edit.id].cutoutId).toBe(cut.id)
    expect(s.batchJobs[job.id].items[0].sourceImageId).toBe(img.id)

    store.update('cutouts', cut.id, { status: 'ready', modelTier: 'full' })
    expect(store.getState().cutouts[cut.id]).toMatchObject({ status: 'ready', modelTier: 'full', id: cut.id })
    expect(s.cutouts[cut.id].status).toBe('pending') // previous snapshot untouched

    expect(store.remove('cutouts', cut.id)).toBe(true)
    expect(store.getState().cutouts[cut.id]).toBeUndefined()
    expect(cut.cutoutBitmap.close).toHaveBeenCalled()
    expect(store.remove('cutouts', cut.id)).toBe(false)
    expect(() => store.update('cutouts', cut.id, {})).toThrow(/not found/)
    expect(() => store.create('sourceImages', img)).toThrow(/already exists/)
  })

  it('notifies subscribers on change', () => {
    const store = createSessionStore()
    const listener = vi.fn()
    const unsub = store.subscribe(listener)
    populate(store)
    expect(listener).toHaveBeenCalledTimes(5)
    unsub()
    store.reset()
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('LOCAL /session/reset clears everything back to an empty session', () => {
    const store = createSessionStore()
    const { img, cut } = populate(store)
    const result = sessionReset(store)
    expect(result).toEqual(emptySession())
    expect(store.getState()).toEqual(emptySession())
    expect(img.decodedBitmap.close).toHaveBeenCalled()
    expect(cut.cutoutBitmap.close).toHaveBeenCalled()
  })
})

describe('no persistence (FR-51, NFR-2)', () => {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {}

  beforeEach(() => {
    spies.storageSet = vi.spyOn(Storage.prototype, 'setItem') as never
    spies.idbOpen = vi.fn()
    spies.cachesOpen = vi.fn()
    spies.cookieSet = vi.fn()
    vi.stubGlobal('indexedDB', { open: spies.idbOpen, deleteDatabase: spies.idbOpen })
    vi.stubGlobal('caches', { open: spies.cachesOpen, delete: spies.cachesOpen })
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: spies.cookieSet as (v: string) => void })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (document as unknown as Record<string, unknown>).cookie
  })

  it('a full store lifecycle writes nothing to localStorage, sessionStorage, IndexedDB, cookies, or Cache API', () => {
    const store = createSessionStore()
    const { cut, job } = populate(store)
    store.update('cutouts', cut.id, { status: 'ready' })
    store.update('batchJobs', job.id, { status: 'complete' })
    store.remove('batchJobs', job.id)
    sessionReset(store)

    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('no app source file references a persistent storage API', () => {
    const banned = /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|CacheStorage)\b/
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f: string) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? walk(p) : [p]
      })
    const offenders = walk(join(import.meta.dirname, '..'))
      .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))
      .filter((p) => banned.test(readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    expect(offenders).toEqual([])
  })
})
