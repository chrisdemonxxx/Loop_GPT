import { describe, expect, it } from 'vitest'
import { canvasFromStored, canvasFromTurn } from '../canvasDoc'
import type { LiveStep } from '../../components/chat/types'

describe('canvasFromTurn', () => {
  it('opens an html document from a create_document step', () => {
    const steps: LiveStep[] = [{
      index: 1,
      kind: 'tool',
      text: '',
      tool: { name: 'create_document', args: { filename: 'index.html', format: 'html', content: '<!doctype html><html><body>Hi</body></html>' } },
    }]
    const doc = canvasFromTurn(steps, '')
    expect(doc?.html).toBe(true)
    expect(doc?.filename).toBe('index.html')
    expect(doc?.content).toContain('<body>Hi</body>')
  })

  it('reads a fence that is still streaming', () => {
    const doc = canvasFromTurn([], '```html\n<!doctype html><html><body>Live</body></html>')
    expect(doc?.html).toBe(true)
    expect(doc?.content).toContain('Live')
  })

  it('rebuilds a canvas from a stored assistant step', () => {
    const doc = canvasFromStored(
      [{ tool: 'create_document', args: { filename: 'app.tsx', format: 'code', content: 'export function App() { return null }' } }],
      '',
    )
    expect(doc?.filename).toBe('app.tsx')
    expect(doc?.html).toBe(false)
  })
})
