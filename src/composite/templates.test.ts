import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundSelection } from '../domain'
import { drawBackground } from './background'
import { bundledTemplate, loadTemplate, resetTemplateCache, templateThumbUrl, TEMPLATES } from './templates'

afterEach(resetTemplateCache)

describe('bundled templates (FR-28, FR-54)', () => {
  it('manifest lists local, same-origin assets with thumbnails', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(6)
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length)
    for (const t of TEMPLATES) {
      expect(t.assetUrl).toMatch(/^\/templates\/[a-z-]+\.webp$/)
      expect(templateThumbUrl(t)).toBe(`/templates/thumbs/${t.id}.webp`)
    }
  })

  it('loads once, then resolves synchronously for drawBackground', async () => {
    const img = { width: 2400, height: 1600 } as unknown as ImageBitmap
    const load = vi.fn(async () => img)
    expect(bundledTemplate('studio-light')).toBeNull()
    await loadTemplate('studio-light', load)
    await loadTemplate('studio-light', load)
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith('/templates/studio-light.webp')
    expect(bundledTemplate('studio-light')).toBe(img)

    // drawBackground uses the bundled cache by default and covers the output (3:2 asset into a square).
    const ctx = { clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D
    drawBackground(ctx, { ...createBackgroundSelection(), type: 'template', templateId: 'studio-light' }, 300, 300)
    expect(ctx.drawImage).toHaveBeenCalledWith(img, -75, 0, 450, 300)
  })

  it('a failed load is not cached, so retry requests it again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ width: 1, height: 1 })
    await expect(loadTemplate('grid-paper', load)).rejects.toThrow('404')
    expect(bundledTemplate('grid-paper')).toBeNull()
    await loadTemplate('grid-paper', load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(bundledTemplate('grid-paper')).not.toBeNull()
  })

  it('rejects unknown ids', async () => {
    await expect(loadTemplate('nope', vi.fn())).rejects.toThrow('Unknown template')
  })
})
