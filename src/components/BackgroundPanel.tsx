import { useRef, useState } from 'react'
import { BACKGROUND_TYPES, type BackgroundSelection, type BackgroundType } from '../domain'
import { decodeBackgroundImage, normalizeHex } from '../composite/background'
import { GRADIENTS } from '../composite/gradients'
import { loadTemplate, TEMPLATES, templateThumbUrl } from '../composite/templates'

interface Props {
  background: BackgroundSelection
  onChange: (next: BackgroundSelection) => void
}

const LABEL: Record<BackgroundType, string> = {
  transparent: 'Transparent',
  solid: 'Solid color',
  image: 'Own image',
  gradient: 'Gradient',
  template: 'Templates',
}

/** Quick picks for Solid color; any colour is available through the picker or hex field. */
const SWATCHES = ['#ffffff', '#000000', '#f2f2f2', '#1f5eff', '#e8433a', '#f5c518', '#2bb673']
export const DEFAULT_SOLID = '#ffffff'

/** FR-24 / FR-25 background panel: five mutually exclusive modes, Transparent by default. */
export function BackgroundPanel({ background: bg, onChange }: Props) {
  const color = normalizeHex(bg.color ?? '') ?? DEFAULT_SOLID
  // The hex field shows what the user is typing while it still describes the current colour (or is unfinished);
  // any other colour change (picker, swatch, undo of mode) shows the canonical hex.
  const [draft, setDraft] = useState<{ text: string; color: string } | null>(null)
  const hexText = draft && draft.color === color ? draft.text : color
  const [imageError, setImageError] = useState<string | null>(null)
  const [decoding, setDecoding] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const decodeToken = useRef(0)
  const hexValid = normalizeHex(hexText) !== null
  // FR-28: per-template load failures (thumbnail or full asset). A failed template shows a placeholder with Retry;
  // every other template and background mode stays usable.
  const [templateFailed, setTemplateFailed] = useState<Record<string, 'thumb' | 'asset'>>({})
  const [thumbAttempt, setThumbAttempt] = useState<Record<string, number>>({})
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const templateToken = useRef(0)

  /** Load the full template, then select it; on failure keep the previous background. Last pick wins. */
  const chooseTemplate = async (id: string) => {
    const token = ++templateToken.current
    setLoadingTemplate(id)
    try {
      await loadTemplate(id)
      if (token === templateToken.current) onChange({ ...bg, type: 'template', templateId: id })
    } catch {
      setTemplateFailed((f) => ({ ...f, [id]: 'asset' }))
    } finally {
      if (token === templateToken.current) setLoadingTemplate(null)
    }
  }
  const retryTemplate = (id: string) => {
    const kind = templateFailed[id]
    setTemplateFailed((f) => {
      const next = { ...f }
      delete next[id]
      return next
    })
    setThumbAttempt((a) => ({ ...a, [id]: (a[id] ?? 0) + 1 }))
    if (kind === 'asset') void chooseTemplate(id)
  }

  // Background shown before Own image was chosen; restored if the first upload cannot be decoded (FR-26).
  const typeBeforeImage = useRef<BackgroundType>('transparent')

  const select = (type: BackgroundType) => {
    if (type === bg.type) return
    setImageError(null)
    if (type === 'image') typeBeforeImage.current = bg.type
    // Other modes' settings are kept (switching back restores them) but only the selected type is ever drawn.
    onChange({
      ...bg,
      type,
      color: type === 'solid' ? color : bg.color,
      // Gradient mode shows the first bundled gradient until the user picks another.
      gradientId: type === 'gradient' ? (bg.gradientId ?? GRADIENTS[0].id) : bg.gradientId,
    })
  }
  const setColor = (value: string) => {
    const hex = normalizeHex(value)
    if (hex) onChange({ ...bg, type: 'solid', color: hex })
  }

  /** FR-26: decode the upload; on failure keep whatever background was selected before. Last pick wins. */
  const uploadImage = async (file: File | undefined) => {
    if (!file) return
    const token = ++decodeToken.current
    setImageError(null)
    setDecoding(true)
    try {
      const decoded = await decodeBackgroundImage(file)
      if (token !== decodeToken.current) {
        decoded.bitmap.close()
        return
      }
      onChange({ ...bg, type: 'image', imageBlob: decoded.blob, imageBitmap: decoded.bitmap })
    } catch {
      if (token !== decodeToken.current) return
      setImageError('Background image could not be decoded')
      // No image to show yet: go back to the background that was visible before (the error stays on screen).
      if (!bg.imageBitmap) onChange({ ...bg, type: typeBeforeImage.current })
    } finally {
      if (token === decodeToken.current) setDecoding(false)
    }
  }

  return (
    <>
      <div className="bg-modes" role="radiogroup" aria-label="Background">
        {BACKGROUND_TYPES.map((type) => (
          <label key={type} className={`bg-mode${bg.type === type ? ' is-selected' : ''}`}>
            <input type="radio" name="background-mode" value={type} checked={bg.type === type} onChange={() => select(type)} />
            {LABEL[type]}
          </label>
        ))}
      </div>

      {bg.type === 'transparent' && <p className="hint">No background. PNG and WebP exports keep transparency.</p>}

      {bg.type === 'solid' && (
        <div className="solid-controls" data-testid="solid-controls">
          <div className="color-row">
            <input
              type="color"
              className="color-picker"
              aria-label="Background color"
              value={color}
              onChange={(e) => setColor(e.currentTarget.value)}
            />
            <label className="hex-field">
              <span className="visually-hidden">Hex color</span>
              <input
                type="text"
                inputMode="text"
                spellCheck={false}
                autoComplete="off"
                maxLength={7}
                aria-label="Hex color"
                aria-invalid={!hexValid}
                value={hexText}
                onChange={(e) => {
                  const text = e.currentTarget.value
                  setDraft({ text, color: normalizeHex(text) ?? color })
                  setColor(text)
                }}
                onBlur={() => setDraft(null)}
              />
            </label>
          </div>
          {!hexValid && (
            <p className="field-error" role="alert">
              Enter a hex color like #1f5eff.
            </p>
          )}
          <div className="swatches" role="group" aria-label="Color presets">
            {SWATCHES.map((s) => (
              <button
                key={s}
                type="button"
                className={`swatch${s === color ? ' is-selected' : ''}`}
                style={{ background: s }}
                aria-label={s}
                aria-pressed={s === color}
                onClick={() => setColor(s)}
              />
            ))}
          </div>
        </div>
      )}

      {bg.type === 'image' && (
        <div className="image-bg-controls" data-testid="image-controls">
          <p className="hint">
            {bg.imageBitmap
              ? `Image behind the cutout: ${bg.imageBitmap.width} × ${bg.imageBitmap.height} px, scaled to cover.`
              : 'Upload a photo to place behind the cutout. It is scaled to cover the output.'}
          </p>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.heic,.heif"
            hidden
            data-testid="background-image-input"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              e.currentTarget.value = '' // allow picking the same file again
              void uploadImage(file)
            }}
          />
          <button type="button" className="btn btn-ghost btn-sm" disabled={decoding} onClick={() => fileInput.current?.click()}>
            {decoding ? 'Loading image…' : bg.imageBitmap ? 'Replace image' : 'Upload image'}
          </button>
        </div>
      )}
      {imageError && (
        <p className="field-error" role="alert">
          {imageError}
        </p>
      )}
      {bg.type === 'gradient' && (
        <div className="gradients" role="group" aria-label="Gradients">
          {GRADIENTS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`gradient-swatch${g.id === bg.gradientId ? ' is-selected' : ''}`}
              style={{ background: g.cssValue }}
              aria-label={g.name}
              aria-pressed={g.id === bg.gradientId}
              title={g.name}
              onClick={() => onChange({ ...bg, type: 'gradient', gradientId: g.id })}
            />
          ))}
        </div>
      )}
      {bg.type === 'template' && (
        <>
          <p className="hint">{bg.templateId ? 'Template scaled to cover the output.' : 'Pick a template to place behind the cutout.'}</p>
          <div className="templates" role="group" aria-label="Templates">
            {TEMPLATES.map((t) => {
              const failed = templateFailed[t.id]
              if (failed)
                return (
                  <div key={t.id} className="template-tile template-placeholder" data-testid={`template-placeholder-${t.id}`}>
                    <span>{t.name} could not be loaded</span>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Retry ${t.name}`} onClick={() => retryTemplate(t.id)}>
                      Retry
                    </button>
                  </div>
                )
              const attempt = thumbAttempt[t.id] ?? 0
              const selected = t.id === bg.templateId
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`template-tile${selected ? ' is-selected' : ''}`}
                  aria-label={t.name}
                  aria-pressed={selected}
                  aria-busy={loadingTemplate === t.id}
                  title={t.name}
                  onClick={() => void chooseTemplate(t.id)}
                >
                  <img
                    key={attempt}
                    src={attempt ? `${templateThumbUrl(t)}?retry=${attempt}` : templateThumbUrl(t)}
                    alt=""
                    width={120}
                    height={80}
                    onError={() => setTemplateFailed((f) => ({ ...f, [t.id]: 'thumb' }))}
                  />
                </button>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}
