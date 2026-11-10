// NFR-18 release audit of the production build (run after `npm run build`): no eval or Function constructor, no
// third-party scripts, styles or trackers, no CDN-hosted runtime assets (onnxruntime WASM, HEIC decoder, models).
// Usage: node scripts/audit-dist.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const dist = process.argv[2] ?? 'dist'
const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
const all = files(dist)
const code = all.filter((p) => /\.(m?js|html|css)$/.test(p))
const problems = []

for (const p of code) {
  const src = readFileSync(p, 'utf8')
  const rel = relative(dist, p)
  if (/(^|[^.\w$])eval\s*\(/.test(src)) problems.push(`${rel}: eval(`)
  if (/new\s+Function\s*\(|[^.\w$]Function\s*\(\s*["'`]/.test(src)) problems.push(`${rel}: Function constructor`)
  if (/sendBeacon|google-analytics|googletagmanager|gtag\(|plausible|mixpanel|segment\.io|hotjar|sentry/i.test(src)) problems.push(`${rel}: tracking code`)
  // Runtime assets must not come from a CDN (onnxruntime defaults to jsDelivr if wasmPaths is not set).
  for (const m of src.matchAll(/https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|[a-z0-9.-]*\.?googleapis\.com|esm\.sh|skypack\.dev)[^"'`\s]*/gi)) {
    problems.push(`${rel}: CDN reference ${m[0]}`)
  }
}

const html = readFileSync(join(dist, 'index.html'), 'utf8')
for (const m of html.matchAll(/<(script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
  if (/^(https?:)?\/\//.test(m[2])) problems.push(`index.html: external ${m[1]} ${m[2]}`)
}

// The model files ship with the app and are referenced by same-origin paths only.
const models = all.filter((p) => p.endsWith('.onnx')).map((p) => relative(dist, p).replace(/\\/g, '/'))
for (const required of ['models/u2netp.onnx', 'models/isnet-general-use.onnx']) {
  if (!models.includes(required)) problems.push(`missing same-origin model ${required}`)
}
const wasm = all.filter((p) => p.endsWith('.wasm')).length
if (wasm === 0) problems.push('no bundled .wasm (onnxruntime would fetch it from a CDN)')

if (problems.length) {
  console.error(`NFR-18 audit failed:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`NFR-18 audit passed: ${code.length} code files, ${wasm} wasm, models ${models.join(', ')}; no eval/Function, trackers, external scripts or CDN assets.`)
