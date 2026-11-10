import { useState } from 'react'
import { EXPORT_FORMATS, type ExportFormat } from '../domain'
import { EXPORT_LABEL, type FormatSupport } from '../export/encode'
import { exportMessage, type ExportOutcome } from '../export/single'

interface Props {
  /** Output size: the source minus the applied crop (FR-31). There is deliberately no downscale control. */
  output: { width: number; height: number }
  /** Which formats this browser can encode natively; null while still checking. PNG is always available. */
  support: FormatSupport | null
  format: ExportFormat
  onFormatChange: (format: ExportFormat) => void
  /** Runs the export; absent for batch items, which are saved through the batch ZIP. */
  onExport?: () => Promise<ExportOutcome>
  /** Why Download is unavailable right now (for example, a crop is being edited). */
  disabledReason?: string | null
}

/** Export panel (FR-30, FR-31, FR-33): format, output size and Download. Failures never change the format or edits. */
export function ExportPanel({ output, support, format, onFormatChange, onExport, disabledReason }: Props) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExportOutcome | null>(null)

  const download = async () => {
    if (!onExport || busy) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await onExport())
    } finally {
      setBusy(false)
    }
  }
  // OQ-6: formats this browser can't encode stay visible but disabled, with the reason (FR-32).
  const available = (f: ExportFormat) => f === 'png' || support?.[f] === true
  const unsupported = support ? EXPORT_FORMATS.filter((f) => !support[f]) : []
  const failed = result !== null && result.kind !== 'saved' && result.kind !== 'canceled'

  if (!onExport)
    return (
      <>
        <p className="output-size" data-testid="output-size">
          {output.width} × {output.height} px
        </p>
        <p className="hint">Batch images are saved as PNG in the batch ZIP.</p>
      </>
    )

  return (
    <>
      <div className="export-formats" role="radiogroup" aria-label="Format">
        {EXPORT_FORMATS.map((f) => (
          <label key={f} className={`bg-mode${f === format ? ' is-selected' : ''}${available(f) ? '' : ' is-disabled'}`}>
            <input
              type="radio"
              name="export-format"
              value={f}
              checked={f === format}
              disabled={busy || !available(f)}
              aria-describedby={unsupported.includes(f) ? 'export-unsupported' : undefined}
              onChange={() => {
                if (!available(f)) return // never select a format this browser cannot encode
                setResult(null)
                onFormatChange(f)
              }}
            />
            {EXPORT_LABEL[f]}
          </label>
        ))}
      </div>
      {unsupported.length > 0 && (
        <p className="hint" id="export-unsupported" data-testid="export-unsupported">
          {unsupported.map((f) => EXPORT_LABEL[f]).join(' and ')} export {unsupported.length > 1 ? "aren't" : "isn't"} supported by this browser.
        </p>
      )}
      <p className="output-size" data-testid="output-size">
        {output.width} × {output.height} px
      </p>
      <button type="button" className="btn btn-primary" disabled={busy || !!disabledReason} onClick={() => void download()}>
        {busy ? 'Exporting…' : `Download ${EXPORT_LABEL[format]}`}
      </button>
      {disabledReason && <p className="hint">{disabledReason}</p>}
      {/* Always mounted, so screen readers announce results politely; failures use an assertive alert. */}
      <div className="export-live" role="status" aria-live="polite">
        {result && (
          <p className={failed ? 'field-error' : 'hint'} role={failed ? 'alert' : undefined} data-testid="export-result">
            {exportMessage(result)}
          </p>
        )}
      </div>
    </>
  )
}
