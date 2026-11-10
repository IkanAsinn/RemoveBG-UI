interface Props {
  onRetry: () => void
}

/** PRD § Network failures: tiny model fetch fails → blocking panel with retry; upload stays usable. */
export function ModelErrorPanel({ onRetry }: Props) {
  return (
    <div className="model-error" role="alert" data-testid="model-error">
      <p>Could not load the background-removal model. Check your connection and retry.</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
