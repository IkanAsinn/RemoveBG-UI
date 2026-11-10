// T-028 / NFR-16: during a batch, never more than one item's full-resolution images are alive at once.
// Counts live main-thread ImageBitmaps of at least 1 MP (created minus closed) while three 12 MP photos are processed.
import { expect, test } from '@playwright/test'

test('batch keeps at most one item’s full-resolution bitmaps alive (NFR-16)', async ({ page, context }) => {
  await context.route('**/models/isnet-general-use.onnx', (r) => r.abort())
  await page.addInitScript(() => {
    const stats = { live: 0, peak: 0, created: 0 }
    ;(window as unknown as { __bitmaps: typeof stats }).__bitmaps = stats
    const create = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>
    const close = ImageBitmap.prototype.close
    const tracked = new WeakSet<ImageBitmap>()
    window.createImageBitmap = (async (...args: unknown[]) => {
      const bm = await create(...args)
      if (bm.width * bm.height >= 1_000_000) {
        tracked.add(bm)
        stats.created++
        stats.peak = Math.max(stats.peak, ++stats.live)
      }
      return bm
    }) as typeof createImageBitmap
    ImageBitmap.prototype.close = function (this: ImageBitmap) {
      if (tracked.delete(this)) stats.live--
      return close.call(this)
    }
  })
  await page.goto('/')
  // Three 4000 × 3000 images, generated in the page as PNG files (so each decode is a real 12 MP bitmap).
  await page.getByRole('button', { name: 'Process a batch' }).click()
  await page.evaluate(async () => {
    const dt = new DataTransfer()
    for (let i = 0; i < 3; i++) {
      const c = new OffscreenCanvas(4000, 3000)
      const cx = c.getContext('2d')!
      cx.fillStyle = ['#d9e4f5', '#f5e6d9', '#e1f5d9'][i]
      cx.fillRect(0, 0, 4000, 3000)
      cx.fillStyle = '#e8703a'
      cx.beginPath()
      cx.arc(2000, 1500, 900, 0, Math.PI * 2)
      cx.fill()
      dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], `big-${i}.png`, { type: 'image/png' }))
    }
    const input = document.querySelector<HTMLInputElement>('[data-testid=batch-input]')!
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.getByRole('button', { name: 'Start batch' }).click()
  await expect(page.getByTestId('batch-progress')).toHaveText('3 done · 0 failed', { timeout: 240_000 })
  const stats = await page.evaluate(() => (window as unknown as { __bitmaps: { live: number; peak: number; created: number } }).__bitmaps)
  test.info().annotations.push({ type: 'bitmaps', description: JSON.stringify(stats) })
  expect(stats.created).toBeGreaterThanOrEqual(3) // each item decoded at full resolution
  expect(stats.peak).toBeLessThanOrEqual(2) // one source + its cutout, never two items
  expect(stats.live).toBe(0) // all released after the batch
})
