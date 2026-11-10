import { useEffect, useRef } from 'react'
import { BackgroundPanel } from './BackgroundPanel'
import { ExportPanel } from './ExportPanel'
import type { ExportOutcome } from '../export/single'
import type { FormatSupport } from '../export/encode'
import { type BackgroundSelection, BRUSH_RADIUS_MAX, BRUSH_RADIUS_MIN, canApplyCrop, CROP_MIN_SIZE, EDGE_VALUE_MAX, EDGE_VALUE_MIN, type CropRect, type EditState, type ExportFormat } from '../domain'

interface Props {
  edit: EditState
  output: { width: number; height: number }
  canUndo: boolean
  canRedo: boolean
  edited: boolean
  onChange: (patch: Partial<Pick<EditState, 'brushMode' | 'brushRadius' | 'edgeValue'>>) => void
  onUndo: () => void
  onRedo: () => void
  onReset: () => void
  /** One edge-slider gesture ended (pointer up, key up or blur): record it as a single undo step. */
  onEdgeCommit: (from: number, to: number) => void
  /** FR-20 crop tool: `cropDraft` is the rectangle being edited, or null when not cropping. */
  cropDraft: CropRect | null
  onCropStart: () => void
  onCropApply: () => void
  onCropCancel: () => void
  onCropFull: () => void
  background: BackgroundSelection
  onBackgroundChange: (background: BackgroundSelection) => void
  exportSupport?: FormatSupport | null
  exportFormat?: ExportFormat
  onExportFormatChange?: (format: ExportFormat) => void
  /** Single-image download; absent for batch items (saved through the batch ZIP). */
  onExport?: () => Promise<ExportOutcome>
}

/**
 * Single-image editor controls (T-010 shell). Brush painting, edge processing, crop, history, backgrounds and export
 * are implemented by T-011…T-020; this panel owns their controls and the editor's empty-state rules.
 */
export function EditorPanel({
  edit,
  output,
  canUndo,
  canRedo,
  edited,
  onChange,
  onUndo,
  onRedo,
  onReset,
  onEdgeCommit,
  cropDraft,
  onCropStart,
  onCropApply,
  onCropCancel,
  onCropFull,
  background,
  onBackgroundChange,
  exportSupport = null,
  exportFormat = 'png',
  onExportFormatChange,
  onExport,
}: Props) {
  const applicable = cropDraft ? canApplyCrop(cropDraft) : false
  // Value at the start of the current edge gesture; the whole drag becomes one history step.
  const edgeStart = useRef<number | null>(null)
  // NFR-12: leaving crop mode (Apply, Cancel, Enter or Escape) removes the focused control; return focus to the Crop
  // button so keyboard users carry on from where they were.
  const cropButton = useRef<HTMLButtonElement>(null)
  const wasCropping = useRef(false)
  useEffect(() => {
    if (wasCropping.current && !cropDraft) {
      const active = document.activeElement
      if (!active || active === document.body) cropButton.current?.focus()
    }
    wasCropping.current = cropDraft !== null
  }, [cropDraft])
  const beginEdge = () => {
    if (edgeStart.current === null) edgeStart.current = edit.edgeValue
  }
  const endEdge = (value: number) => {
    const from = edgeStart.current
    edgeStart.current = null
    if (from !== null) onEdgeCommit(from, value)
  }
  return (
    <aside className="editor-panel" aria-label="Editing tools">
      <section className="tool-group" aria-labelledby="tools-history">
        <h2 id="tools-history" className="visually-hidden">
          History
        </h2>
        <div className="button-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onUndo} disabled={!canUndo}>
            Undo
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRedo} disabled={!canRedo}>
            Redo
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReset} disabled={!edited}>
            Reset edits
          </button>
        </div>
      </section>

      <section className="tool-group" aria-labelledby="tools-brush">
        <h2 id="tools-brush">Brush</h2>
        <div className="segmented" role="radiogroup" aria-label="Brush mode">
          {(['erase', 'restore'] as const).map((mode) => (
            <label key={mode} className={`segment${edit.brushMode === mode ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="brush-mode"
                value={mode}
                checked={edit.brushMode === mode}
                onChange={() => onChange({ brushMode: mode })}
              />
              {mode === 'erase' ? 'Erase' : 'Restore'}
            </label>
          ))}
        </div>
        <label className="slider">
          <span>
            Size <output>{edit.brushRadius}px</output>
          </span>
          <input
            type="range"
            aria-label="Brush size"
            min={BRUSH_RADIUS_MIN}
            max={BRUSH_RADIUS_MAX}
            value={edit.brushRadius}
            onChange={(e) => onChange({ brushRadius: Number(e.currentTarget.value) })}
          />
        </label>
      </section>

      <section className="tool-group" aria-labelledby="tools-edge">
        <h2 id="tools-edge">Edge</h2>
        <label className="slider">
          <span>
            Softness <output>{edit.edgeValue}</output>
          </span>
          <input
            type="range"
            aria-label="Edge softness"
            min={EDGE_VALUE_MIN}
            max={EDGE_VALUE_MAX}
            value={edit.edgeValue}
            onPointerDown={beginEdge}
            onKeyDown={beginEdge}
            onChange={(e) => {
              beginEdge()
              onChange({ edgeValue: Number(e.currentTarget.value) })
            }}
            onPointerUp={(e) => endEdge(Number(e.currentTarget.value))}
            onKeyUp={(e) => endEdge(Number(e.currentTarget.value))}
            onBlur={(e) => endEdge(Number(e.currentTarget.value))}
          />
        </label>
      </section>

      <section className="tool-group" aria-labelledby="tools-crop">
        <h2 id="tools-crop">Crop</h2>
        {cropDraft ? (
          <>
            <p className="crop-size" data-testid="crop-size" aria-live="polite">
              {cropDraft.width} × {cropDraft.height} px
            </p>
            {!applicable && (
              <p className="hint" data-testid="crop-min">
                Minimum crop is {CROP_MIN_SIZE} × {CROP_MIN_SIZE} px.
              </p>
            )}
            <div className="button-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={onCropApply} disabled={!applicable}>
                Apply crop
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCropCancel}>
                Cancel
              </button>
              <button type="button" className="btn btn-link btn-sm" onClick={onCropFull}>
                Full image
              </button>
            </div>
          </>
        ) : (
          <button ref={cropButton} type="button" className="btn btn-ghost btn-sm" onClick={onCropStart}>
            {edit.crop ? 'Adjust crop' : 'Crop image'}
          </button>
        )}
      </section>

      <section className="tool-group" aria-labelledby="tools-background" data-testid="background-panel">
        <h2 id="tools-background">Background</h2>
        <BackgroundPanel background={background} onChange={onBackgroundChange} />
      </section>

      <section className="tool-group" aria-labelledby="tools-export" data-testid="export-panel">
        <h2 id="tools-export">Export</h2>
        <ExportPanel
          output={output}
          support={exportSupport}
          format={exportFormat}
          onFormatChange={(f) => onExportFormatChange?.(f)}
          onExport={onExport}
          disabledReason={cropDraft ? 'Apply or cancel the crop to download.' : null}
        />
      </section>
    </aside>
  )
}
