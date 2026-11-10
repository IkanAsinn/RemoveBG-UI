// FR-35 output file names: `{source-basename}-nobg.{ext}`, unique within one ZIP.

/** Strip any directory part and the last extension; never empty. */
export function sourceBasename(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? ''
  const dot = leaf.lastIndexOf('.')
  const base = (dot > 0 ? leaf.slice(0, dot) : leaf).trim()
  return base || 'image'
}

export const outputFileName = (sourceName: string, ext: string): string => `${sourceBasename(sourceName)}-nobg.${ext}`

/**
 * Unique ZIP entry names: the first use of a name is kept, later collisions get an index suffix
 * (`photo-nobg.png`, `photo-nobg-2.png`, …). Comparison ignores case so the archive extracts cleanly on
 * case-insensitive file systems.
 */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = name
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem}-${i}${ext}`
    used.add(candidate.toLowerCase())
    return candidate
  })
}
