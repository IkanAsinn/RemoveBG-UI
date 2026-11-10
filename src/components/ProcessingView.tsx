import { useEffect, useRef, useState } from 'react'
import {
  canApplyCrop,
  fullCrop,
  hasEdits,
  normalizeCrop,
  outputSize,
  type BrushStroke,
  type CropRect,
  type ExportFormat,
  type CutoutResult,
  type EditState,
  type SourceImage,
  createBackgroundSelection,
  type BackgroundSelection,
  type MatteSource,
} from '../domain'
import type { UpgradeState } from '../matte/useFullUpgrade'
import { EditCanvas, PREVIEW_MAX } from './EditCanvas'
import { EditorPanel } from './EditorPanel'
import type { ExportOutcome } from '../export/single'
import type { FormatSupport } from '../export/encode'

export type ProcessingPhase = 'Preparing model' | 'Removing background' | 'Applying full model'

interface Props {
  image: SourceImage
  /** The latest cutout; when ready it replaces the source in the preview and the editor opens. */
  cutout?: CutoutResult
  edit?: EditState
  phase: ProcessingPhase
  /** 0–1 download progress for the current phase, or null when unknown. */
  progress?: number | null
  /** True when processing cannot continue; the phase indicator is hidden. */
  blocked?: boolean
  error?: string | null
  notice?: string | null
  onRetry?: () => void
  onStartOver: () => void
  onNewImage: (files: File[]) => void
  onEditChange?: (patch: Partial<EditState>) => void
  onResetEdits?: () => void
  onStroke?: (stroke: BrushStroke) => void
  onEdgeCommit?: (from: number, to: number) => void
  onCropChange?: (crop: CropRect | null) => void
  background?: BackgroundSelection
  onBackgroundChange?: (background: BackgroundSelection) => void
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** Full-model upgrade state, shown over the tiny result (FR-12–FR-14). */
  upgrade?: UpgradeState
  onRetryUpgrade?: () => void
  /** Batch item editing (FR-43): replaces New image / Start over with a save-and-return action. */
  onBackToQueue?: () => void
  savingToQueue?: boolean
  /** Export panel (FR-30…FR-36); onExport is absent for batch items. */
  exportSupport?: FormatSupport | null
  exportFormat?: ExportFormat
  onExportFormatChange?: (format: ExportFormat) => void
  onExport?: () => Promise<ExportOutcome>
  /** Switch the cutout between the AI model and the background colour key (single images only). */
  onMatteChange?: (source: MatteSource) => void
  /** The method a cutout is being redone with, while that runs. */
  matteTarget?: MatteSource | null
}

/** FR-7 processing state, then the single-image editor once a cutout is ready. */
export function ProcessingView({
  image,
  cutout,
  edit,
  phase,
  progress = null,
  blocked = false,
  error = null,
  notice = null,
  onRetry,
  onStartOver,
  onNewImage,
  onEditChange,
  onResetEdits,
  onStroke,
  onEdgeCommit,
  onCropChange,
  background,
  onBackgroundChange,
  exportSupport,
  exportFormat,
  onExportFormatChange,
  onExport,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  upgrade = { status: 'idle' },
  onRetryUpgrade,
  onBackToQueue,
  savingToQueue = false,
  onMatteChange,
  matteTarget = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasResult = cutout?.status === 'ready'
  const editing = hasResult && !!edit
  const upgrading = hasResult && (upgrade.status === 'loading' || upgrade.status === 'running')
  const pill = upgrading
    ? { phase: 'Applying full model' as const, progress: upgrade.status === 'loading' ? upgrade.progress : null }
    : !hasResult && !blocked
      ? { phase, progress }
      : null
  const shown = hasResult ? cutout.cutoutBitmap : image.decodedBitmap
  const output = outputSize(image, editing ? edit : null)

  // FR-20: the crop being edited. Apply writes EditState.crop; Cancel just drops the draft (prior crop kept).
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null)
  useEffect(() => setCropDraft(null), [image.id, editing])
  const startCrop = () => setCropDraft(edit?.crop ?? fullCrop(image.width, image.height))
  const applyCrop = () => {
    if (!cropDraft || !canApplyCrop(cropDraft)) return
    onCropChange?.(normalizeCrop(cropDraft, image.width, image.height))
    setCropDraft(null)
  }
  const cancelCrop = () => setCropDraft(null)

  // Before the editor opens: draw from decoded bitmaps (not the original blob) so WASM-decoded HEIC renders in
  // every browser. Once editing, EditCanvas owns the preview.
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const src = { x: 0, y: 0, width: image.width, height: image.height }
    const scale = Math.min(1, PREVIEW_MAX / Math.max(src.width, src.height))
    canvas.width = Math.round(src.width * scale)
    canvas.height = Math.round(src.height * scale)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(shown, src.x, src.y, src.width, src.height, 0, 0, canvas.width, canvas.height)
  }, [image, shown, editing])

  return (
    <section
      className={`processing${editing ? ' is-editing' : ''}`}
      aria-labelledby="processing-title"
      data-testid="processing-view"
      data-decode-path={image.decodePath}
      data-model-tier={hasResult ? cutout.modelTier : undefined}
      data-matte-source={hasResult ? cutout.matteSource : undefined}
      data-cutout-size={hasResult ? `${cutout.cutoutBitmap.width}x${cutout.cutoutBitmap.height}` : undefined}
      data-full-model={upgrade.status}
    >
      <div className="processing-head">
        <h1 id="processing-title" className="file-name">
          {image.fileName}
        </h1>
        <div className="head-actions">
          {onBackToQueue ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onBackToQueue} disabled={savingToQueue}>
              {savingToQueue ? 'Saving…' : 'Back to queue'}
            </button>
          ) : (
            <>
              <label className="btn btn-ghost btn-sm">
                New image
                <input
                  className="visually-hidden"
                  type="file"
                  accept="image/*,.heic,.heif,.avif"
                  data-testid="new-image-input"
                  onChange={(e) => {
                    // Snapshot first: clearing the input empties the live FileList before a deferred (confirmed) action runs.
                    onNewImage(Array.from(e.currentTarget.files ?? []))
                    e.currentTarget.value = ''
                  }}
                />
              </label>
              <button type="button" className="btn btn-link" onClick={onStartOver}>
                Start over
              </button>
            </>
          )}
        </div>
      </div>
      <p className="meta">
        {image.width} × {image.height} px
      </p>
      {error && (
        <div className="error error-row" role="alert">
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="btn btn-ghost" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {hasResult && (upgrade.status === 'failed' || upgrade.status === 'interrupted') && (
        <div className="notice notice-row" role="status" data-testid="upgrade-notice">
          <span>
            {upgrade.status === 'interrupted'
              ? 'Full model interrupted.'
              : 'The full model could not be applied. Showing the quick result.'}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onRetryUpgrade}>
            {upgrade.status === 'interrupted' ? 'Retry' : 'Retry full model'}
          </button>
        </div>
      )}
      <div className="workspace">
        <figure className={`preview${hasResult ? ' has-result' : ''}`}>
          {editing ? (
            <EditCanvas
              image={image}
              cutout={cutout}
              edit={edit}
              background={background}
              onStroke={(s) => onStroke?.(s)}
              cropDraft={cropDraft}
              onCropDraftChange={setCropDraft}
              onCropApply={applyCrop}
              onCropCancel={cancelCrop}
            />
          ) : (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={hasResult ? `Background removed: ${image.fileName}` : `Original: ${image.fileName}`}
              data-testid="source-preview"
            />
          )}
          {pill && (
            <figcaption className="phase" role="status" aria-live="polite" data-testid="phase">
              <span className="spinner" aria-hidden="true" />
              {pill.phase}…{pill.progress !== null && pill.progress > 0 && pill.progress < 1 && ` ${Math.round(pill.progress * 100)}%`}
            </figcaption>
          )}
        </figure>
        {editing && (
          <EditorPanel
            edit={edit}
            output={output}
            canUndo={canUndo}
            canRedo={canRedo}
            edited={hasEdits(edit)}
            onChange={(patch) => onEditChange?.(patch)}
            onUndo={() => onUndo?.()}
            onRedo={() => onRedo?.()}
            onEdgeCommit={(from, to) => onEdgeCommit?.(from, to)}
            onReset={() => {
              setCropDraft(null)
              onResetEdits?.()
            }}
            cropDraft={cropDraft}
            onCropStart={startCrop}
            onCropApply={applyCrop}
            onCropCancel={cancelCrop}
            onCropFull={() => setCropDraft(fullCrop(image.width, image.height))}
            background={background ?? createBackgroundSelection()}
            onBackgroundChange={(bg) => onBackgroundChange?.(bg)}
            exportSupport={exportSupport}
            exportFormat={exportFormat}
            onExportFormatChange={onExportFormatChange}
            onExport={onExport}
            matteSource={matteTarget ?? cutout.matteSource}
            onMatteChange={onMatteChange}
            matteBusy={matteTarget !== null}
          />
        )}
      </div>
    </section>
  )
}
