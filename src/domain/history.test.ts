import { describe, expect, it } from 'vitest'
import { createEditState } from './factories'
import { createHistory, deltaPatch, type EditSnapshot } from './history'
import type { BrushStroke } from './types'

const stroke = (x: number): BrushStroke => ({ mode: 'erase', radius: 5, points: [{ x, y: x }] })
const base = (): EditSnapshot => {
  const { strokes, edgeValue, crop } = createEditState('c')
  return { strokes, edgeValue, crop }
}

describe('edit history (FR-22, FR-23)', () => {
  it('undoes and redoes 20+ mixed brush, edge and crop changes back to the start and forward again', () => {
    const h = createHistory()
    let e = base()
    const states: EditSnapshot[] = [e]
    const apply = (patch: Partial<EditSnapshot>) => (e = { ...e, ...patch })
    for (let i = 0; i < 24; i++) {
      if (i % 3 === 0) {
        const s = stroke(i)
        h.push('id', { kind: 'stroke', stroke: s })
        apply(deltaPatch(e, { kind: 'stroke', stroke: s }, 'redo'))
      } else if (i % 3 === 1) {
        const to = 10 + i
        h.push('id', { kind: 'edge', from: e.edgeValue, to })
        apply({ edgeValue: to })
      } else {
        const to = { x: i, y: i, width: 100 + i, height: 80 }
        h.push('id', { kind: 'crop', from: e.crop, to })
        apply({ crop: to })
      }
      states.push(e)
    }
    expect(h.depth('id')).toEqual({ undo: 24, redo: 0 })
    for (let i = states.length - 2; i >= 0; i--) {
      apply(h.undo('id', e)!)
      expect(e).toEqual(states[i])
    }
    expect(h.canUndo('id')).toBe(false)
    expect(h.undo('id', e)).toBeNull() // boundary
    for (let i = 1; i < states.length; i++) {
      apply(h.redo('id', e)!)
      expect(e).toEqual(states[i])
    }
    expect(h.canRedo('id')).toBe(false)
    expect(h.redo('id', e)).toBeNull()
  })

  it('a new change after undo clears redo', () => {
    const h = createHistory()
    h.push('id', { kind: 'edge', from: 50, to: 60 })
    h.undo('id', { ...base(), edgeValue: 60 })
    expect(h.canRedo('id')).toBe(true)
    h.push('id', { kind: 'edge', from: 50, to: 30 })
    expect(h.canRedo('id')).toBe(false)
  })

  it('keeps at most the limit (never fewer than 20) and drops the oldest', () => {
    const h = createHistory(25)
    for (let i = 0; i < 40; i++) h.push('id', { kind: 'edge', from: i, to: i + 1 })
    expect(h.depth('id').undo).toBe(25)
  })

  it('reset is one undoable step that restores strokes, edge and crop', () => {
    const before: EditSnapshot = { strokes: [stroke(1), stroke(2)], edgeValue: 20, crop: { x: 1, y: 2, width: 30, height: 40 } }
    const h = createHistory()
    h.push('id', { kind: 'reset', before })
    const cleared = { ...before, ...deltaPatch(before, { kind: 'reset', before }, 'redo') }
    expect(cleared).toEqual({ strokes: [], edgeValue: 50, crop: null })
    expect({ ...cleared, ...h.undo('id', cleared)! }).toEqual(before)
  })

  it('histories are per image and can be cleared; listeners are notified', () => {
    const h = createHistory()
    let calls = 0
    h.subscribe(() => calls++)
    h.push('a', { kind: 'edge', from: 50, to: 51 })
    h.push('b', { kind: 'edge', from: 50, to: 52 })
    h.clear('a')
    expect(h.canUndo('a')).toBe(false)
    expect(h.canUndo('b')).toBe(true)
    h.clear()
    expect(h.canUndo('b')).toBe(false)
    expect(calls).toBe(4)
  })
})
