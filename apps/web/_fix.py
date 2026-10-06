p = 'app/components/chat/__tests__/Composer.test.tsx'
s = open(p, 'rb').read().decode('utf-8')
i = s.find("  it('effort selector:")
assert i > 0
# end = closing '  })' of the second (marks explicit) block
j = s.find("  })\n})", i)
assert j > i
blk = s[i:j+5]
assert blk.count("  it(") == 2, blk.count("  it(")
new = """  it('effort selector: all six positions, aria-selected marks the active, pick dispatches', () => {
    const onToggle = vi.fn()
    renderComposer({ thinking: 'xhigh', onToggle })
    const btn = screen.getByTitle(/reasoning effort: xhigh/i)
    fireEvent.click(btn)
    for (const id of ['auto', 'low', 'medium', 'high', 'xhigh', 'off'] as const) {
      expect(screen.getByRole('menuitem', { name: new RegExp(`^${id[0].toUpperCase()}${id.slice(1)}$`, 'i') })).toBeInTheDocument()
    }
    expect(screen.getByRole('menuitem', { name: /^XHigh$/i }).getAttribute('aria-selected')).toBe('true')
    for (const next of ['auto', 'low', 'medium', 'high', 'xhigh', 'off'] as const) {
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${next[0].toUpperCase()}${next.slice(1)}$`, 'i')}))
      expect(onToggle).toHaveBeenCalledWith(next)
    }
  })

  it('marks explicit toggle states visually (on + high = terracotta)', () => {
    renderComposer({ webSearch: 'on', thinking: 'high' })
    const web = screen.getByRole('button', { name: /web search: on/i })
    const brain = screen.getByRole('button', { name: /reasoning effort: high/i })
    expect(web.className).toContain('text-[#e79d7f]')
    expect(web.getAttribute('aria-pressed')).toBe('true')
    expect(brain.className).toContain('text-[#e79d7f]')
    expect(brain.getAttribute('aria-pressed')).toBe('true')
  })"""
s2 = s[:i] + new + s[j+5:]
open(p, 'wb').write(s2.encode('utf-8'))
print('replaced', len(blk))
