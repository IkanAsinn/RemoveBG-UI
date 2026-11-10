import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundSelection, type BackgroundSelection } from '../domain'
import { loadTemplate } from '../composite/templates'
import { BackgroundPanel } from './BackgroundPanel'

vi.mock('../composite/templates', async (orig) => ({
  ...(await orig<typeof import('../composite/templates')>()),
  loadTemplate: vi.fn(async () => ({ width: 2400, height: 1600 })),
}))

const seen = {} as { bg: BackgroundSelection }
function Harness({ initial }: { initial: Partial<BackgroundSelection> }) {
  const [bg, setBg] = useState(() => (seen.bg = createBackgroundSelection(initial)))
  const change = (next: BackgroundSelection) => {
    seen.bg = next
    setBg(next)
  }
  return <BackgroundPanel background={bg} onChange={change} />
}
const grid = () => screen.getByRole('group', { name: 'Templates' })

afterEach(() => {
  cleanup()
  vi.mocked(loadTemplate).mockReset().mockImplementation(async () => ({ width: 2400, height: 1600 }) as ImageBitmap)
})

describe('Templates (FR-28)', () => {
  it('shows a thumbnail grid from the local manifest and selects a template after it loads', async () => {
    render(<Harness initial={{ type: 'template' }} />)
    const tiles = within(grid()).getAllByRole('button')
    expect(tiles.length).toBe(8)
    const srcs = within(grid()).getAllByRole('presentation', { hidden: true }).map((i) => i.getAttribute('src'))
    expect(srcs.every((s) => s!.startsWith('/templates/thumbs/'))).toBe(true)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Bokeh night' })))
    expect(loadTemplate).toHaveBeenCalledWith('bokeh-night')
    expect(seen.bg).toMatchObject({ type: 'template', templateId: 'bokeh-night' })
    expect(screen.getByRole('button', { name: 'Bokeh night' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a missing template shows a placeholder with retry and keeps the previous background', async () => {
    vi.mocked(loadTemplate).mockRejectedValueOnce(new Error('404'))
    render(<Harness initial={{ type: 'template', color: '#1f5eff' }} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Grid paper' })))
    expect(screen.getByTestId('template-placeholder-grid-paper').textContent).toContain('Grid paper could not be loaded')
    expect(seen.bg.templateId).toBeNull()

    // Other templates and other modes still work.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Studio light' })))
    expect(seen.bg.templateId).toBe('studio-light')
    fireEvent.click(screen.getByRole('radio', { name: 'Solid color' }))
    expect(seen.bg).toMatchObject({ type: 'solid', color: '#1f5eff' })
    fireEvent.click(screen.getByRole('radio', { name: 'Templates' }))

    // Retry loads the asset again and selects it.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry Grid paper' })))
    expect(screen.queryByTestId('template-placeholder-grid-paper')).toBeNull()
    expect(seen.bg.templateId).toBe('grid-paper')
  })

  it('a thumbnail that fails to load becomes a placeholder; retry re-requests it', () => {
    render(<Harness initial={{ type: 'template' }} />)
    const img = screen.getByRole('button', { name: 'Mint arches' }).querySelector('img')!
    fireEvent.error(img)
    fireEvent.click(screen.getByRole('button', { name: 'Retry Mint arches' }))
    const again = screen.getByRole('button', { name: 'Mint arches' }).querySelector('img')!
    expect(again.getAttribute('src')).toBe('/templates/thumbs/mint-arches.webp?retry=1')
    expect(loadTemplate).not.toHaveBeenCalled()
  })
})
