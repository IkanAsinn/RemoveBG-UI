import { describe, expect, it } from 'vitest'
import { applyEdge } from './edge'
import { createEdgeService } from './edgeService'

const W = 40
const H = 30
const base = () => {
  const m = new Uint8ClampedArray(W * H)
  for (let y = 8; y < 22; y++) for (let x = 10; x < 30; x++) m[y * W + x] = 255
  return m
}
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('edge service (latest value wins)', () => {
  it('computes the requested value with the shared transform', async () => {
    const got: Array<[number, Uint8ClampedArray]> = []
    const svc = createEdgeService(base(), W, H, (v, m) => got.push([v, m]))
    svc.request(10)
    await settle()
    expect(got.map(([v]) => v)).toEqual([10])
    expect(got[0][1]).toEqual(applyEdge(base(), W, H, 10))
  })

  it('a burst of slider values computes the first and the last only', async () => {
    const got: number[] = []
    const svc = createEdgeService(base(), W, H, (v) => got.push(v))
    for (const v of [45, 40, 35, 30, 25, 20]) svc.request(v)
    await settle()
    expect(got).toEqual([45, 20])
  })

  it('stops delivering after dispose', async () => {
    const got: number[] = []
    const svc = createEdgeService(base(), W, H, (v) => got.push(v))
    svc.request(80)
    svc.dispose()
    svc.request(90)
    await settle()
    expect(got).toEqual([])
  })
})
