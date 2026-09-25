import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Markdown from '../Markdown'

/** Math/LaTeX rendering (audit §8-27): remark-math + rehype-katex render
 * inline ($...$) and block ($$...$$) math to KaTeX markup. */

describe('Markdown math', () => {
  it('renders inline math to KaTeX markup', () => {
    render(<Markdown content={'Einstein said $E = mc^2$ famously.'} />)
    const el = screen.getByText(/Einstein said famously/)
    // KaTeX produces its own span structure inside the paragraph.
    expect(el.querySelector('.katex')).not.toBeNull()
    expect(el.textContent).toContain('E=mc2')
  })

  it('renders block math with display mode', () => {
    const { container } = render(<Markdown content={'$$\n\\int_0^1 x^2 dx\n$$'} />)
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('leaves a single unpaired $ as plain text (no false math)', () => {
    const { container } = render(<Markdown content={'That costs $5 total.'} />)
    // One $ cannot pair, so remark-math never produces math markup.
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$5')
  })
})
