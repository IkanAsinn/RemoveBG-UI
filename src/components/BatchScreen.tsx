import { useState, useSyncExternalStore, type DragEvent } from 'react'
import { sessionStore, type BatchItemStatus } from '../domain'
import { batchInput, createBatch, currentBatch, discardBatch, zipStreaming } from '../batch/queue'
import { formatBytes, validateBatch } from '../batch/validate'
import { BatchModelUnavailableError, failureReason, processBatch, type BatchDeps } from '../batch/process'
import { defaultBatchDeps } from '../batch/models'
import { downloadBatchZip, type DownloadDeps, type ZipOutcome } from '../batch/download'

interface Props {
  onBack: () => void
  /** FR-43: open a Done item in the editor. Resolves once the editor can show it. */
  onOpenItem?: (jobId: string, itemId: string) => Promise<void>
  /** Model/decoder/encoder wiring; tests inject fakes. */
  deps?: () => BatchDeps
  /** ZIP destination wiring; tests inject fakes. */
  zipDeps?: DownloadDeps
}

const STATUS_LABEL: Record<BatchItemStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  done: 'Done',
  failed: 'Failed',
}

/** Batch entry (FR-38–FR-40): pick up to 20 images / 100 MB, validated before anything is processed, then the queue. */
export function BatchScreen({ onBack, onOpenItem, deps = defaultBatchDeps, zipDeps }: Props) {
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getState)
  const job = currentBatch(session)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  useSyncExternalStore(zipStreaming.subscribe, zipStreaming.getVersion)
  const zipping = !!job && zipStreaming.has(job.id)
  const [opening, setOpening] = useState<string | null>(null)
  const [zipOutcome, setZipOutcome] = useState<ZipOutcome | null>(null)
  const downloadZip = () => {
    if (!job) return
    setZipOutcome(null)
    // No await before this call: the save picker needs the click's user activation.
    downloadBatchZip(job.id, zipDeps).then(setZipOutcome, () => setZipOutcome({ kind: 'incomplete' }))
  }
  const [openError, setOpenError] = useState<string | null>(null)
  const openItem = async (itemId: string) => {
    if (!job || !onOpenItem || opening) return
    setOpenError(null)
    setOpening(itemId)
    try {
      await onOpenItem(job.id, itemId)
    } catch {
      setOpenError('This image could not be opened for editing.')
    } finally {
      setOpening(null)
    }
  }

  const start = () => {
    if (!job) return
    setStartError(null)
    processBatch(job.id, deps()).catch((e) => {
      setStartError(e instanceof BatchModelUnavailableError ? e.message : 'The batch could not be started.')
    })
  }
  const processing = job?.status === 'processing'
  const finished = job?.status === 'complete' || job?.status === 'failed'
  const activeIndex = job ? job.items.findIndex((i) => i.status === 'processing') : -1
  const doneCount = job ? job.items.filter((i) => i.status === 'done').length : 0
  const failedItems = job ? job.items.filter((i) => i.status === 'failed') : []
  const nameOf = (sourceImageId: string) =>
    session.sourceImages[sourceImageId]?.fileName ?? batchInput(sourceImageId)?.name ?? 'Unknown file'

  const select = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const result = validateBatch(Array.from(list)) // snapshot: the live FileList empties when the input is reset
    const skipped = result.skipped > 0 ? `${result.skipped} non-image file${result.skipped === 1 ? '' : 's'} skipped.` : null
    if (!result.ok) {
      setError(result.message)
      setNotice(result.code === 'empty' ? null : skipped)
      return
    }
    setError(null)
    setNotice(skipped)
    createBatch(result.files, result.totalBytes)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!job) select(e.dataTransfer.files)
  }

  return (
    <section className={job ? 'batch' : 'empty'} aria-labelledby="batch-title">
      <button type="button" className="btn btn-link back" onClick={onBack}>
        ← Back
      </button>
      <h1 id="batch-title">Process a batch</h1>

      {!job && (
        <div
          className={`dropzone${dragOver ? ' is-dragover' : ''}`}
          data-testid="batch-dropzone"
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <label className="btn btn-primary">
            Choose images
            <input
              className="visually-hidden"
              type="file"
              multiple
              accept="image/*,.heic,.heif,.avif"
              data-testid="batch-input"
              onChange={(e) => {
                select(e.currentTarget.files)
                e.currentTarget.value = ''
              }}
            />
          </label>
          <p className="hint">or drop images here</p>
          <p className="limits">Up to 20 images · 100 MB total</p>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {job && (
        <>
          <div className="batch-summary">
            <p data-testid="batch-summary">
              {job.items.length} image{job.items.length === 1 ? '' : 's'} · {formatBytes(job.totalInputBytes)} of 100 MB
            </p>
            <div className="batch-actions">
              {job.status !== 'failed' && (
                <button
                  type="button"
                  className={`btn ${doneCount > 0 ? "btn-primary" : "btn-ghost"} btn-sm`}
                  disabled={doneCount === 0 || processing || job.status === 'editing' || zipping}
                  onClick={downloadZip}
                >
                  {zipping ? 'Writing ZIP…' : 'Download ZIP'}
                </button>
              )}
              {job.status === 'ready' && (
                <button type="button" className="btn btn-primary btn-sm" onClick={start}>
                  {startError ? 'Retry' : 'Start batch'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={processing}
                onClick={() => {
                  discardBatch(job.id)
                  setNotice(null)
                }}
              >
                Clear batch
              </button>
            </div>
          </div>
          {zipOutcome?.kind === 'saved' && (
            <p className="notice" role="status">
              ZIP saved with {zipOutcome.entries} image{zipOutcome.entries === 1 ? '' : 's'}. Failed images are not included.
            </p>
          )}
          {zipOutcome?.kind === 'canceled' && (
            <p className="notice" role="status">
              Save canceled. No ZIP was written; the batch is still here.
            </p>
          )}
          {zipOutcome?.kind === 'incomplete' && (
            <p className="error" role="alert">
              ZIP download was incomplete
            </p>
          )}
          {zipOutcome?.kind === 'unsupported' && (
            <p className="error" role="alert">
              This browser can’t stream a ZIP download. Try Chrome or Edge, or a window where site data is allowed.
            </p>
          )}
          {openError && (
            <p className="error" role="alert">
              {openError}
            </p>
          )}
          {zipping && (
            <p className="notice" role="status">
              Editing is disabled while the ZIP is being written.
            </p>
          )}
          {startError && (
            <p className="error" role="alert">
              {startError}
            </p>
          )}
          <p className="batch-progress" role="status" aria-live="polite" data-testid="batch-progress">
            {processing &&
              (activeIndex < 0
                ? 'Preparing model…'
                : `Processing image ${activeIndex + 1} of ${job.items.length}…`)}
            {finished && `${doneCount} done · ${failedItems.length} failed`}
          </p>
          {job.status === 'failed' && (
            <div className="error batch-all-failed" role="alert" data-testid="batch-error-summary">
              <p>No images could be processed, so no ZIP was created.</p>
              <ul>
                {failedItems.map((i) => (
                  <li key={i.id}>
                    {nameOf(i.sourceImageId)}: {failureReason(i.errorCode)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {job.status !== 'failed' && failedItems.length > 0 && (
            <div className="batch-failures" data-testid="batch-failures">
              <h2>Failed images</h2>
              <ul>
                {failedItems.map((i) => (
                  <li key={i.id}>
                    <strong>{nameOf(i.sourceImageId)}</strong>: {failureReason(i.errorCode)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <table className="batch-queue" aria-label="Batch queue">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Dimensions</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {job.items.map((item) => {
                const image = session.sourceImages[item.sourceImageId]
                const name = nameOf(item.sourceImageId)
                return (
                  <tr key={item.id} data-status={item.status}>
                    <th scope="row" className="batch-name">
                      {name}
                    </th>
                    <td>{image ? `${image.width} × ${image.height}` : <span aria-label="Not known yet">—</span>}</td>
                    <td>
                      <span className={`status-badge is-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                      {item.status === 'failed' && <span className="batch-reason"> {failureReason(item.errorCode)}</span>}
                      {item.edited && <span className="status-badge is-edited">Edited</span>}
                    </td>
                    <td className="batch-row-actions">
                      {item.status === 'done' && onOpenItem && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={`Edit ${name}`}
                          disabled={processing || zipping || opening !== null}
                          onClick={() => void openItem(item.id)}
                        >
                          {opening === item.id ? 'Opening…' : 'Edit'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
