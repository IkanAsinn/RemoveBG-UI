// T-027 / NFR-12: accessibility checks on the production build.
// 1. axe-core (WCAG 2.1 A/AA rules, including colour contrast and accessible names) on every screen and panel state,
//    in the light and the dark theme.
// 2. A keyboard-only journey: open a file, pick a background, crop (apply and cancel) and export without a pointer,
//    with a visible focus indicator on every stop.
import AxeBuilder from '@axe-core/playwright'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function violations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
}

/** Scan, collecting every violation under a label so one run reports all states at once. */
function scanner(page: Page) {
  const found: Record<string, string[]> = {}
  return {
    scan: async (label: string) => {
      const v = await violations(page)
      if (v.length) found[label] = v
    },
    found,
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${colorScheme} theme`, () => {
    test.use({ colorScheme })
    test.beforeEach(({ context }) => context.route('**/models/isnet-general-use.onnx', (r) => r.abort()))

    test('single-image flow: home, editor, every background mode, crop, export results', async ({ page }) => {
      const { scan, found } = scanner(page)
      await page.addInitScript(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker)
      await page.goto('/')
      await scan('home')
      await page.getByTestId('upload-input').setInputFiles(fixture('corrupt.png'))
      await expect(page.getByRole('alert')).toBeVisible()
      await scan('home with decode error')

      await page.getByTestId('upload-input').setInputFiles(fixture('photo.png'))
      await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })
      await expect(page.getByTestId('upgrade-notice')).toBeVisible({ timeout: 60_000 })
      await scan('editor (tiny result, full-model notice)')
      for (const mode of ['Solid color', 'Own image', 'Gradient', 'Templates']) {
        await page.locator('label.bg-mode', { hasText: mode }).click()
        await scan(`background: ${mode}`)
      }
      await page.getByRole('button', { name: 'Studio light' }).click()
      await expect(page.getByRole('button', { name: 'Studio light' })).toHaveAttribute('aria-pressed', 'true')
      await page.getByRole('button', { name: 'Crop image' }).click()
      await scan('crop mode')
      await page.getByRole('button', { name: 'Apply crop' }).click()
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download PNG' }).click()
      await download
      await expect(page.getByTestId('export-result')).toContainText('Saved')
      await scan('export saved')
      expect(found).toEqual({})
    })

    test('batch flow: empty, validation error, queue, results with failures', async ({ page }) => {
      const { scan, found } = scanner(page)
      await page.goto('/')
      await page.getByRole('button', { name: 'Process a batch' }).click()
      await scan('batch empty')
      await page.evaluate(() => {
        const dt = new DataTransfer()
        for (let i = 0; i < 21; i++) dt.items.add(new File(['x'], `img-${i}.png`, { type: 'image/png' }))
        const input = document.querySelector<HTMLInputElement>('[data-testid=batch-input]')!
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await expect(page.getByRole('alert')).toHaveText('Maximum 20 images per batch.')
      await scan('batch validation error')
      await page.getByTestId('batch-input').setInputFiles([fixture('photo.png'), fixture('corrupt.png')])
      await scan('batch queued')
      await page.getByRole('button', { name: 'Start batch' }).click()
      await expect(page.getByText('1 done · 1 failed')).toBeVisible({ timeout: 120_000 })
      await scan('batch done with a failure')
      await page.getByRole('button', { name: 'Clear batch' }).click()
      await page.getByTestId('batch-input').setInputFiles([fixture('corrupt.png')])
      await page.getByRole('button', { name: 'Start batch' }).click()
      await expect(page.getByTestId('batch-error-summary')).toBeVisible({ timeout: 60_000 })
      await scan('batch all failed')
      expect(found).toEqual({})
    })
  })
}

/** True when the focused element (or the label/control wrapping it) draws a focus indicator. */
const focusIsVisible = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return false
    for (let e: Element | null = el, d = 0; e && d < 3; e = e.parentElement, d++) {
      const s = getComputedStyle(e)
      if ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none') return true
    }
    return false
  })

/** Press Tab (or Shift+Tab) until `target` has focus; every stop on the way must show a visible focus indicator. */
async function tabTo(page: Page, target: ReturnType<Page['locator']>, back = false) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab')
    const atBody = await page.evaluate(() => document.activeElement === document.body)
    if (!atBody) expect(await focusIsVisible(page), 'focus indicator').toBe(true)
    if (await target.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error(`could not reach ${target} with the keyboard`)
}

test.describe('keyboard only (NFR-12)', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.route('**/models/isnet-general-use.onnx', (r) => r.abort())
    await page.addInitScript(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker)
  })

  test('open a file, choose backgrounds, cancel and apply a crop, export', async ({ page }) => {
    await page.goto('/')
    // Open the file picker from the keyboard.
    await tabTo(page, page.getByTestId('upload-input'))
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Space')
    await (await chooser).setFiles(fixture('photo.png'))
    await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })

    // Background: arrow keys move between modes; swatches and templates are buttons.
    await tabTo(page, page.getByRole('radio', { name: 'Transparent' }))
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Solid color' })).toBeChecked()
    await tabTo(page, page.getByRole('button', { name: '#1f5eff' }))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '#1f5eff' })).toHaveAttribute('aria-pressed', 'true')
    await tabTo(page, page.getByRole('radio', { name: 'Solid color' }), true)
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight') // Own image → Gradient → Templates
    await expect(page.getByRole('radio', { name: 'Templates' })).toBeChecked()
    await tabTo(page, page.getByRole('button', { name: 'Studio light' }))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Studio light' })).toHaveAttribute('aria-pressed', 'true')

    // Crop: opening moves focus onto the crop area; Escape cancels and Enter applies, focus returns to the button.
    const size = page.getByTestId('output-size')
    await expect(size).toHaveText('1200 × 800 px')
    await tabTo(page, page.getByRole('button', { name: 'Crop image' }), true)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('crop-rect')).toBeFocused()
    await tabTo(page, page.getByLabel('Resize crop from bottom-right corner'))
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Crop image' })).toBeFocused()
    await expect(size).toHaveText('1200 × 800 px')

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('crop-rect')).toBeFocused()
    await tabTo(page, page.getByLabel('Resize crop from bottom-right corner'))
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowLeft')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Adjust crop' })).toBeFocused()
    const cropped = await size.innerText()
    expect(cropped).not.toBe('1200 × 800 px')

    // Export: format radios by arrow keys, then Download.
    await tabTo(page, page.getByTestId('export-panel').getByRole('radio', { name: 'PNG' }))
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'WebP' })).toBeChecked()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('export-panel').getByRole('radio', { name: 'PNG' })).toBeChecked()
    await tabTo(page, page.getByRole('button', { name: 'Download PNG' }))
    const download = page.waitForEvent('download')
    await page.keyboard.press('Enter')
    expect((await download).suggestedFilename()).toBe('photo-nobg.png')
    await expect(page.getByTestId('export-result')).toHaveText(`Saved photo-nobg.png (${cropped}).`)
  })

  test('batch: choose files, start, edit a row, return, download the ZIP', async ({ page }) => {
    await page.goto('/')
    await tabTo(page, page.getByRole('button', { name: 'Process a batch' }))
    await page.keyboard.press('Enter')
    await tabTo(page, page.getByTestId('batch-input'))
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Space')
    await (await chooser).setFiles([fixture('photo.png'), fixture('corrupt.png')])
    await tabTo(page, page.getByRole('button', { name: 'Start batch' }))
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('batch-progress')).toHaveText('1 done · 1 failed', { timeout: 120_000 })

    await tabTo(page, page.getByRole('button', { name: 'Edit photo.png' }))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible()
    await tabTo(page, page.getByRole('button', { name: 'Back to queue' }))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('table', { name: 'Batch queue' })).toBeVisible()

    await tabTo(page, page.getByRole('button', { name: 'Download ZIP' }))
    const download = page.waitForEvent('download')
    await page.keyboard.press('Enter')
    expect((await download).suggestedFilename()).toBe('nobg-images.zip')
    await expect(page.getByText(/ZIP saved with 1 image/)).toBeVisible()
  })
})
