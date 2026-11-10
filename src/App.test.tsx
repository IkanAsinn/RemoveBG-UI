import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// The model loader is exercised in src/model/*.test.ts; here it stays pending so the shell is in its normal loading state.
vi.mock('./model/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model/loader')>()),
  loadModel: vi.fn(() => new Promise(() => {})),
}))


afterEach(cleanup)

const root = join(import.meta.dirname, '..')
const banned = /sign ?up|log ?in|create (an )?account|subscribe|premium|upgrade|pricing|\bpro plan\b|advertis|sponsored/i

describe('app shell first load (FR-1)', () => {
  it('shows upload control, paste instruction, and batch entry point', () => {
    render(<App />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(screen.getByText('Upload image')).toBeTruthy()
    expect(screen.getByTestId('paste-instruction').textContent).toMatch(/paste an image from the clipboard/i)
    expect(screen.getByRole('button', { name: 'Process a batch' })).toBeTruthy()
  })

  it('renders no canvas, background panel, or export panel before an image is ingested', () => {
    const { container } = render(<App />)
    expect(container.querySelector('canvas')).toBeNull()
    expect(screen.queryByText(/export|download|background panel/i)).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('batch entry point opens the batch empty state with limits, and Back returns', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Process a batch' }))
    expect(screen.getByTestId('batch-dropzone').textContent).toContain('Up to 20 images · 100 MB total')
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByTestId('upload-input')).toBeTruthy()
  })
})

describe('product constraints (FR-50, FR-56)', () => {
  it('shows no signup, ad, or paid-tier copy in any shell view', () => {
    const { container } = render(<App />)
    // The footer may state "No signup" as a promise; strip that before checking for prompts.
    const text = () => (container.textContent ?? '').replace(/No signup\./g, '')
    expect(text()).not.toMatch(banned)
    fireEvent.click(screen.getByRole('button', { name: 'Process a batch' }))
    expect(text()).not.toMatch(banned)
  })

  it('index.html loads only the same-origin app entry: no analytics, ad, or third-party scripts', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8')
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])
    expect(scripts).toEqual(['/src/main.tsx'])
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/gtag|googletagmanager|analytics|plausible|segment|hotjar|adsbygoogle/i)
  })
})
