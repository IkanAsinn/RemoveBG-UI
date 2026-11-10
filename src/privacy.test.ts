// Static guardrails (FR-51, FR-56, NFR-2, NFR-13, NFR-18): shipped code must not persist user data, phone home, or
// add monetisation UI. Model files may still use plain HTTP caching (the browser's, not the Cache API).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(tsx?|js|html|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}
const shipped = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'public')), join(ROOT, 'index.html')].filter(
  (p) => !p.includes(`${join('public', 'models')}`),
)
/** File contents without comments, so explanatory comments ("never uses localStorage") are not flagged. */
const source = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')

describe('privacy guardrails', () => {
  it('no persistent browser storage for user data', () => {
    const forbidden = /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open|navigator\.storage)\b/
    expect(shipped.filter((p) => forbidden.test(source(p)))).toEqual([])
  })

  it('no beacons, analytics or third-party scripts', () => {
    const tracking = /sendBeacon|google-analytics|googletagmanager|gtag\(|plausible|mixpanel|segment\.io|hotjar|sentry/i
    expect(shipped.filter((p) => tracking.test(source(p)))).toEqual([])
    const scripts = [...source(join(ROOT, 'index.html')).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])
    expect(scripts).toEqual(['/src/main.tsx'])
  })

  it('no network calls other than same-origin GETs for app assets', () => {
    // Every fetch/XHR in shipped code; each must be a same-origin asset or the ZIP worker keep-alive.
    const calls = shipped.flatMap((p) => [...source(p).matchAll(/\b(fetch|XMLHttpRequest)\s*\(/g)].map(() => p))
    const allowed = ['loader.ts', 'save.ts']
    expect(calls.filter((p) => !allowed.some((a) => p.endsWith(a)))).toEqual([])
    expect(shipped.some((p) => /method:\s*['"](POST|PUT|PATCH)['"]/.test(source(p)))).toBe(false)
  })

  it('no ads, signup, paid tier or watermark flows', () => {
    const ui = shipped.filter((p) => /\.(tsx|html)$/.test(p)).map(source).join('\n')
    // Standalone words only: `store.subscribe(...)` is code, not a subscription flow.
    expect(ui).not.toMatch(/(?<![.\w])(sign ?in|create (an )?account|log ?in|subscribe|pricing|upgrade to pro|premium|advertis\w*|adsbygoogle)(?![\w(])/i)
    // "watermark" only appears in the promise that there is none.
    for (const m of ui.matchAll(/[^.\n]*watermark[^.\n]*/gi)) expect(m[0]).toMatch(/no watermark/i)
  })
})
