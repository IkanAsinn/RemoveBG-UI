import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App'
import { sessionReset, sessionStore } from './domain'

function file(name: string, size = 1000, type = 'image/jpeg'): File {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const many = (n: number, size = 1000) => Array.from({ length: n }, (_, i) => file(`img-${i + 1}.jpg`, size))
const jobs = () => Object.values(sessionStore.getState().batchJobs)

function openBatch() {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Process a batch' }))
}
const choose = (files: File[]) => fireEvent.change(screen.getByTestId('batch-input'), { target: { files } })

afterEach(() => {
  cleanup()
  sessionReset()
})

describe('batch entry (FR-38–FR-40, NFR-6)', () => {
  it('the empty batch screen shows the dropzone and the limits', () => {
    openBatch()
    const zone = screen.getByTestId('batch-dropzone')
    expect(within(zone).getByText('Up to 20 images · 100 MB total')).toBeTruthy()
    expect((screen.getByTestId('batch-input') as HTMLInputElement).multiple).toBe(true)
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('more than 20 files is blocked and creates no partial batch', () => {
    openBatch()
    choose(many(21))
    expect(screen.getByRole('alert').textContent).toBe('Maximum 20 images per batch.')
    expect(jobs()).toEqual([])
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('more than 100 MB shows the computed total and the cap and does not start', () => {
    openBatch()
    choose(many(3, 40 * 1024 * 1024))
    const msg = screen.getByRole('alert').textContent!
    expect(msg).toContain('120.0 MB (125,829,120 bytes)')
    expect(msg).toContain('100 MB (104,857,600 bytes)')
    expect(jobs()).toEqual([])
  })

  it('a valid selection renders one queued row per image with file name and status', () => {
    openBatch()
    choose(many(20, 1024 * 1024))
    expect(screen.queryByRole('alert')).toBeNull()
    const rows = within(screen.getByRole('table', { name: 'Batch queue' })).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(20)
    expect(within(rows[0]).getByRole('rowheader').textContent).toBe('img-1.jpg')
    expect(rows.every((r) => r.textContent!.includes('Queued'))).toBe(true)
    expect(screen.getByTestId('batch-summary').textContent).toBe('20 images · 20.0 MB of 100 MB')
    expect(jobs()).toHaveLength(1)
    expect(jobs()[0]).toMatchObject({ status: 'ready', totalInputBytes: 20 * 1024 * 1024 })
  })

  it('a blocked selection can be corrected; Clear batch returns to the empty state', () => {
    openBatch()
    choose(many(25))
    choose(many(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('row')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Clear batch' }))
    expect(jobs()).toEqual([])
    expect(screen.getByTestId('batch-dropzone')).toBeTruthy()
  })

  it('the queue survives going back to home and returning', () => {
    openBatch()
    choose(many(2))
    fireEvent.click(screen.getByRole('button', { name: '← Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Process a batch' }))
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })
})
