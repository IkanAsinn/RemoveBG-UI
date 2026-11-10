import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EmptyState } from './components/EmptyState'
import { BatchScreen } from './components/BatchScreen'
import { ProcessingView } from './components/ProcessingView'
import { ModelErrorPanel } from './components/ModelErrorPanel'
import { ConfirmDialog } from './components/ConfirmDialog'
import { useModel } from './model/useModel'
import { CanvasTooLargeError, removeBackground } from './matte/remove'
import { useFullUpgrade } from './matte/useFullUpgrade'
import {
  createEditState,
  EDGE_VALUE_DEFAULT,
  editHistory,
  editStateForImage,
  hasEdits,
  sessionStore,
  type BrushStroke,
  type CropRect,
  type EditDelta,
  type EditState,
  type ExportFormat,
  type SourceKind,
} from './domain'
import { firstImageFile, ingestImage, IngestError } from './image/ingest'
import { closeBatchItem, openBatchItem } from './batch/edit'
import { batchEditsPending, zipStreaming } from './batch/queue'
import { needsUnloadConfirmation, useBeforeUnload } from './session/unloadGuard'
import { exportSingle } from './export/single'
import { detectFormatSupport, type FormatSupport } from './export/encode'
import {
  clipboardFileName,
  imageFromPasteEvent,
  isTextEntryTarget,
  NO_IMAGE_MESSAGE,
  readClipboardImage,
  UNAVAILABLE_MESSAGE,
} from './image/clipboard'
import './App.css'

type View = 'home' | 'batch'

export default function App() {
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getState)
  const [view, setView] = useState<View>('home')
  const [currentImageId, setCurrentImageId] = useState<string | null>(null)
  const [decoding, setDecoding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // FR-10: the tiny model loads up front; a failure shows a retry path but never blocks ingestion (NFR-17).
  const { state: tinyModel, retry: retryTinyModel } = useModel('tiny')

  const [removeError, setRemoveError] = useState<string | null>(null)
  const removingFor = useRef<string | null>(null)

  // FR-43: a Done batch item open in the editor. While set it replaces the single-image flow; the queue is kept.
  const [batchEdit, setBatchEdit] = useState<{ jobId: string; itemId: string } | null>(null)
  const [savingBatchItem, setSavingBatchItem] = useState(false)
  // FR-30: PNG by default; kept across exports and failures (FR-36).
  const [exportFormat, setExportFormat] = useState<ExportFormat>('png')
  // FR-32 / OQ-6: probe the native encoders once; unsupported formats are shown disabled.
  const [formatSupport, setFormatSupport] = useState<FormatSupport | null>(null)
  useEffect(() => {
    let live = true
    detectFormatSupport().then(
      (s) => live && setFormatSupport(s),
      () => live && setFormatSupport({ png: true, webp: false, jxl: false }),
    )
    return () => {
      live = false
    }
  }, [])
  const batchItem = batchEdit ? session.batchJobs[batchEdit.jobId]?.items.find((i) => i.id === batchEdit.itemId) : undefined
  const current = batchEdit
    ? batchItem && session.sourceImages[batchItem.sourceImageId]
    : currentImageId
      ? session.sourceImages[currentImageId]
      : undefined
  // Prefer the full-model cutout once it exists (FR-12).
  const cutouts = current ? Object.values(session.cutouts).filter((c) => c.sourceImageId === current.id) : []
  const cutout = cutouts.find((c) => c.modelTier === 'full') ?? cutouts[0]
  // Batch items keep the model they were processed with: the upgrade would replace the cutout the item points at.
  const { state: upgrade, retry: retryUpgrade } = useFullUpgrade(batchEdit ? undefined : current, cutout)
  const edit = current ? editStateForImage(session, current.id) : undefined
  const edited = hasEdits(edit)
  /** FR-9: an action that would discard edits, waiting for the user's confirmation. */
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null)

  // Editor state: one EditState per image, created with the first ready cutout and kept when tiny → full.
  useEffect(() => {
    if (!current || cutout?.status !== 'ready') return
    if (!edit) sessionStore.create('editStates', createEditState(cutout.id))
    else if (edit.cutoutId !== cutout.id) sessionStore.update('editStates', edit.id, { cutoutId: cutout.id })
  }, [current, cutout, edit])

  /** Drop an image and everything derived from it from the session. */
  const discardImage = (id: string | null) => {
    if (!id) return
    const state = sessionStore.getState()
    const e = editStateForImage(state, id)
    if (e) {
      sessionStore.remove('editStates', e.id)
      editHistory.clear(e.id)
    }
    for (const c of Object.values(state.cutouts)) if (c.sourceImageId === id) sessionStore.remove('cutouts', c.id)
    sessionStore.remove('sourceImages', id)
  }

  /** FR-9: run `action` now, or after confirmation when the open image has edits. Cancel changes nothing. */
  const requestNewImage = (action: () => void) => {
    if (edited) setPendingDiscard(() => action)
    else action()
  }

  const updateEdit = (patch: Partial<EditState>) => {
    if (edit) sessionStore.update('editStates', edit.id, patch)
  }

  // FR-22: every committed brush stroke, edge change and crop change is one undo step (EditState deltas only).
  useSyncExternalStore(editHistory.subscribe, editHistory.getVersion)
  const canUndo = !!edit && editHistory.canUndo(edit.id)
  const canRedo = !!edit && editHistory.canRedo(edit.id)
  const record = (delta: EditDelta) => {
    if (edit) editHistory.push(edit.id, delta)
  }
  const addStroke = (stroke: BrushStroke) => {
    if (!edit) return
    updateEdit({ strokes: [...edit.strokes, stroke] })
    record({ kind: 'stroke', stroke })
  }
  /** The slider updates the edge live; one history step is recorded when the drag or key press ends. */
  const commitEdge = (from: number, to: number) => {
    if (from !== to) record({ kind: 'edge', from, to })
  }
  const changeCrop = (crop: CropRect | null) => {
    if (!edit || JSON.stringify(edit.crop) === JSON.stringify(crop)) return
    record({ kind: 'crop', from: edit.crop, to: crop })
    updateEdit({ crop })
  }
  /** FR-23: back to the auto-removal result (one undoable step). Brush mode and size are tool settings, not edits. */
  const resetEdits = () => {
    if (!edit || !hasEdits(edit)) return
    record({ kind: 'reset', before: { strokes: edit.strokes, edgeValue: edit.edgeValue, crop: edit.crop } })
    updateEdit({ strokes: [], edgeValue: EDGE_VALUE_DEFAULT, crop: null })
  }
  const undo = () => {
    const patch = edit && editHistory.undo(edit.id, edit)
    if (patch) updateEdit(patch)
  }
  const redo = () => {
    const patch = edit && editHistory.redo(edit.id, edit)
    if (patch) updateEdit(patch)
  }
  const historyKeys = useRef({ undo, redo, active: false })
  historyKeys.current = { undo, redo, active: !!edit && cutout?.status === 'ready' && !pendingDiscard }
  // Ctrl/Cmd+Z undo; Ctrl/Cmd+Shift+Z or Ctrl+Y redo. Text fields keep their own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = historyKeys.current
      if (!k.active || !(e.ctrlKey || e.metaKey) || e.altKey || isTextEntryTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) k.undo()
      else if ((key === 'z' && e.shiftKey) || key === 'y') k.redo()
      else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // FR-10 / FR-16: once the tiny model is ready, run it on the current image at full resolution.
  useEffect(() => {
    if (!current || tinyModel.status !== 'ready' || cutout || removeError || removingFor.current === current.id) return
    const image = current
    removingFor.current = image.id
    // Let the "Removing background" phase paint before the model occupies the main thread.
    new Promise((r) => setTimeout(r, 30))
      .then(() => removeBackground(tinyModel.handle, image))
      .then((result) => {
        if (sessionStore.getState().sourceImages[image.id]) sessionStore.create('cutouts', result)
        else result.cutoutBitmap.close() // image was discarded while processing
      })
      .catch((e) => {
        if (removingFor.current === image.id) {
          setRemoveError(e instanceof CanvasTooLargeError ? e.message : 'Background removal failed for this image.')
        }
      })
      .finally(() => {
        if (removingFor.current === image.id) removingFor.current = null
      })
  }, [current, tinyModel, cutout, removeError])

  // Dropping a file anywhere outside the upload area must not navigate the tab away from the app.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  /** Shared ingestion path for upload, drop, and clipboard. */
  const ingest = useCallback(
    async (blob: Blob, fileName: string, kind: SourceKind) => {
      setError(null)
      setNotice(null)
      setDecoding(true)
      try {
        const image = await ingestImage(blob, fileName, kind)
        discardImage(currentImageId)
        sessionStore.create('sourceImages', image)
        setRemoveError(null)
        setCurrentImageId(image.id)
      } catch (e) {
        setError(e instanceof IngestError ? e.message : `${fileName}: Unsupported or corrupt image.`)
      } finally {
        setDecoding(false)
      }
    },
    [currentImageId],
  )

  /** FR-2: ingest the first image file of a picker selection or drop. An empty selection (picker cancel) is a no-op. */
  const handleFiles = useCallback(
    (files: ArrayLike<File> | null) => {
      if (!files || files.length === 0) return
      const file = firstImageFile(files) ?? files[0]
      void ingest(file, file.name, 'upload')
    },
    [ingest],
  )

  // Paste works on the upload screen and in the editor (where it replaces the image, with FR-9 confirmation).
  const acceptsPaste = !batchEdit && (current ? cutout?.status === 'ready' : view === 'home') && !decoding && !pendingDiscard
  const editedRef = useRef(edited)
  editedRef.current = edited

  // FR-3: platform paste shortcut while the document has focus; pastes inside text fields are ignored.
  useEffect(() => {
    if (!acceptsPaste) return
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntryTarget(e.target)) return
      e.preventDefault()
      const file = imageFromPasteEvent(e.clipboardData)
      if (!file) return setNotice(NO_IMAGE_MESSAGE) // FR-4
      const run = () => void ingest(file, clipboardFileName(file.type), 'clipboard')
      if (editedRef.current) setPendingDiscard(() => run)
      else run()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [acceptsPaste, ingest])

  /** FR-3 Paste button: async Clipboard API with the OQ-7 fallback message when denied or unsupported. */
  const pasteFromButton = async () => {
    setError(null)
    setNotice(null)
    const result = await readClipboardImage()
    if (result.kind === 'image') await ingest(result.blob, clipboardFileName(result.blob.type), 'clipboard')
    else setNotice(result.kind === 'empty' ? NO_IMAGE_MESSAGE : UNAVAILABLE_MESSAGE)
  }

  const openBatchEditor = async (jobId: string, itemId: string) => {
    await openBatchItem(jobId, itemId)
    setBatchEdit({ jobId, itemId })
  }
  /** Save the item's edits back to the batch and return to the queue. */
  const backToQueue = async () => {
    if (!batchEdit || savingBatchItem) return
    setSavingBatchItem(true)
    try {
      await closeBatchItem(batchEdit.jobId, batchEdit.itemId)
    } finally {
      setSavingBatchItem(false)
      setBatchEdit(null)
    }
  }

  // FR-52: confirm leaving while work is in progress or unsaved.
  useSyncExternalStore(zipStreaming.subscribe, zipStreaming.getVersion)
  const jobs = Object.values(session.batchJobs)
  useBeforeUnload(
    needsUnloadConfirmation({
      singleProcessing:
        !batchEdit &&
        (decoding ||
          (!!current && cutout?.status !== 'ready' && removeError === null && tinyModel.status !== 'error') ||
          upgrade.status === 'loading' ||
          upgrade.status === 'running'),
      singleEdited: !batchEdit && edited,
      batchProcessing: jobs.some((j) => j.status === 'processing'),
      zipStreaming: jobs.some((j) => zipStreaming.has(j.id)),
      batchUnsavedEdits: (!!batchEdit && edited) || jobs.some((j) => batchEditsPending(j.id)),
    }),
  )

  const startOver = () => {
    discardImage(currentImageId)
    removingFor.current = null
    setRemoveError(null)
    setCurrentImageId(null)
  }

  return (
    <div className="shell" data-tiny-model={tinyModel.status}>
      <header className="shell-header">
        <a className="brand" href="/" aria-label="Remove Background, home">
          <span className="brand-mark" aria-hidden="true" />
          Remove Background
        </a>
      </header>

      <main className="shell-main">
        {tinyModel.status === 'error' && <ModelErrorPanel onRetry={retryTinyModel} />}
        {current ? (
          <ProcessingView
            image={current}
            cutout={cutout}
            phase={tinyModel.status === 'ready' ? 'Removing background' : 'Preparing model'}
            progress={tinyModel.status === 'loading' ? tinyModel.progress : null}
            blocked={tinyModel.status === 'error' || removeError !== null}
            error={removeError}
            onRetry={() => setRemoveError(null)}
            onStartOver={() => requestNewImage(startOver)}
            onNewImage={(files) => {
              if (files.length > 0) requestNewImage(() => handleFiles(files))
            }}
            edit={edit}
            onEditChange={updateEdit}
            onResetEdits={resetEdits}
            onStroke={addStroke}
            onEdgeCommit={commitEdge}
            onCropChange={changeCrop}
            background={session.background}
            onBackgroundChange={sessionStore.setBackground}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            notice={notice}
            upgrade={upgrade}
            onRetryUpgrade={retryUpgrade}
            onBackToQueue={batchEdit ? backToQueue : undefined}
            exportSupport={formatSupport}
            exportFormat={exportFormat}
            onExportFormatChange={setExportFormat}
            onExport={
              batchEdit || !cutout || cutout.status !== 'ready'
                ? undefined
                : () => exportSingle({ image: current, cutout, edit: edit ?? null, background: session.background, format: exportFormat })
            }
            savingToQueue={savingBatchItem}
          />
        ) : view === 'batch' ? (
          <BatchScreen onBack={() => setView('home')} onOpenItem={openBatchEditor} />
        ) : (
          <EmptyState
            onOpenBatch={() => setView('batch')}
            onFiles={handleFiles}
            onPaste={pasteFromButton}
            decoding={decoding}
            error={error}
            notice={notice}
          />
        )}
      </main>

      {pendingDiscard && (
        <ConfirmDialog
          title="Discard your edits?"
          message="Opening a new image will discard the edits to the current one."
          confirmLabel="Discard edits"
          onConfirm={() => {
            const action = pendingDiscard
            setPendingDiscard(null)
            action()
          }}
          onCancel={() => setPendingDiscard(null)}
        />
      )}

      <footer className="shell-footer">
        <p>Free. No signup. No watermark. Your photos are processed on this device and never uploaded.</p>
      </footer>
    </div>
  )
}
