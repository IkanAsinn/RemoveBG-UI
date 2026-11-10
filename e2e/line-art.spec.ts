// Flat graphics (line art) are keyed by colour instead of the AI model, and the edge-aware brush only touches colours
// like the one under the start of the stroke. Real build, real browser, real canvas.
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const FIXTURE = fileURLToPath(new URL('./fixtures/lines.png', import.meta.url))
// e2e/fixtures/lines.png: 1600 × 1000, white, with 10 px black lines centred on y = 50 + 80k + 25·sin(x / 120 + k).
const W = 1600
const H = 1000
const lineY = (x: number, k: number) => 50 + 80 * k + 25 * Math.sin(x / 120 + k)

/** Alpha of the editor preview at an image pixel (the preview is the image at 1:1 for this size). */
const alphaAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=processing-view] canvas')!
      return c.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data[3]
    },
    [x, y],
  )

/** Drag through image pixels `path` (honouring the preview's letterboxing). */
async function drag(page: Page, path: Array<[number, number]>) {
  const box = (await page.locator('[data-testid=processing-view] canvas').first().boundingBox())!
  const k = Math.min(box.width / W, box.height / H)
  const at = ([x, y]: [number, number]) => [box.x + (box.width - W * k) / 2 + x * k, box.y + (box.height - H * k) / 2 + y * k] as const
  await page.mouse.move(...at(path[0]))
  await page.mouse.down()
  for (const p of path.slice(1)) await page.mouse.move(...at(p), { steps: 4 })
  await page.mouse.up()
}
/** Points along line k between x0 and x1. */
const alongLine = (k: number, x0: number, x1: number) => {
  const pts: Array<[number, number]> = []
  for (let x = x0; x <= x1; x += 35) pts.push([x, lineY(x, k)])
  return pts
}

test('line art: colour key, no full model, edge-aware restore, method switch keeps edits', async ({ page }) => {
  const modelRequests: string[] = []
  page.on('request', (r) => r.url().includes('isnet') && modelRequests.push(r.url()))
  await page.goto('/')
  await page.getByTestId('upload-input').setInputFiles(FIXTURE)
  const view = page.getByTestId('processing-view')
  await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })

  // 1. Keyed by colour: gaps fully transparent, lines fully opaque, and the full model is never fetched.
  await expect(view).toHaveAttribute('data-matte-source', 'color')
  await expect(page.getByRole('radio', { name: 'Background colour' })).toBeChecked()
  const x = 800
  for (const k of [3, 6, 9]) {
    expect(await alphaAt(page, x, lineY(x, k))).toBe(255)
    expect(await alphaAt(page, x, lineY(x, k) + 40)).toBe(0)
  }
  await page.waitForTimeout(1500)
  await expect(view).toHaveAttribute('data-full-model', 'idle')
  expect(modelRequests).toEqual([])

  // 2. Plain erase wipes a band (lines included)…
  await page.getByRole('slider', { name: 'Brush size' }).fill('60')
  await drag(page, alongLine(6, 500, 1100))
  await expect.poll(() => alphaAt(page, x, lineY(x, 6))).toBe(0)

  // 3. …then an edge-aware restore that starts on the line brings back only the black line, not the white gaps.
  await page.getByRole('radio', { name: 'Restore' }).check({ force: true })
  await page.getByRole('checkbox', { name: 'Auto-detect edges' }).check()
  await expect(page.getByRole('slider', { name: 'Edge tolerance' })).toBeVisible()
  await drag(page, alongLine(6, 520, 1080))
  await expect.poll(() => alphaAt(page, x, lineY(x, 6))).toBe(255)
  expect(await alphaAt(page, x, lineY(x, 6) + 22)).toBe(0) // white gap under the brush stays erased

  // 4. Switching to the AI and back redoes the cutout; brush work carries over.
  await page.getByRole('radio', { name: 'AI subject' }).check({ force: true })
  await expect(view).toHaveAttribute('data-matte-source', 'model', { timeout: 120_000 })
  await expect(page.getByRole('radio', { name: 'Background colour' })).toBeEnabled()
  await page.getByRole('radio', { name: 'Background colour' }).check({ force: true })
  await expect(view).toHaveAttribute('data-matte-source', 'color', { timeout: 60_000 })
  await expect.poll(() => alphaAt(page, x, lineY(x, 6))).toBe(255)
  expect(await alphaAt(page, x, lineY(x, 3))).toBe(255)
  expect(await alphaAt(page, x, lineY(x, 3) + 40)).toBe(0)
})
