import { useState, type DragEvent } from 'react'

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const pasteShortcut = isApple ? '⌘V' : 'Ctrl+V'

interface Props {
  onOpenBatch: () => void
  onFiles: (files: FileList | null) => void
  onPaste: () => void
  decoding: boolean
  error: string | null
  notice: string | null
}

/** FR-1: first-load empty state — upload control, paste instruction, batch entry point. No canvas or panels. */
export function EmptyState({ onOpenBatch, onFiles, onPaste, decoding, error, notice }: Props) {
  const [dragOver, setDragOver] = useState(false)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    onFiles(e.dataTransfer.files)
  }

  return (
    <section className="empty" aria-labelledby="empty-title">
      <h1 id="empty-title">Remove the background from any photo</h1>
      <p className="lede">Get a transparent cutout in your browser, at full resolution.</p>

      <div
        className={`dropzone${dragOver ? ' is-dragover' : ''}`}
        data-testid="upload-area"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <label className="btn btn-primary" aria-disabled={decoding}>
          {decoding ? 'Opening image…' : 'Upload image'}
          <input
            className="visually-hidden"
            type="file"
            accept="image/*,.heic,.heif,.avif"
            data-testid="upload-input"
            disabled={decoding}
            onChange={(e) => {
              onFiles(e.currentTarget.files)
              e.currentTarget.value = '' // allow re-selecting the same file
            }}
          />
        </label>
        <p className="hint">or drop an image here</p>
        <p className="paste-hint" data-testid="paste-instruction">
          You can also paste an image from the clipboard with <kbd>{pasteShortcut}</kbd> or{' '}
          <button type="button" className="btn btn-inline" onClick={onPaste} disabled={decoding}>
            Paste
          </button>
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="notice" role="status" data-testid="notice">
        {notice}
      </p>

      <div className="batch-entry">
        <button type="button" className="btn btn-ghost" onClick={onOpenBatch}>
          Process a batch
        </button>
        <span className="hint">Up to 20 images · 100 MB total</span>
      </div>
    </section>
  )
}
