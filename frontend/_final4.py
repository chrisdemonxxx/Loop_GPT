p = 'app/components/chat/__tests__/Composer.test.tsx'
raw = open(p, 'rb').read().decode('utf-8').replace('\r\n', '\n')

fx_old = "  thinking: 'auto' as 'auto' | 'on' | 'off',"
assert raw.count(fx_old) == 1
raw = raw.replace(fx_old, "  thinking: 'auto' as 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'off',")

start = raw.find("  it('renders the web-search")
end = raw.find("  it('marks explicit toggle states")
assert 0 < start < end, (start, end)
rng = raw[start:end]
assert rng.count("  it(") in (1, 2)
assert rng.rstrip().endswith('}'), repr(rng[-80:])

new_range = """  it('renders the web-search tri-state and the 6-way effort selector', () => {
    const onToggleWebSearch = vi.fn()
    const onToggleThinking = vi.fn()
    renderComposer({ onToggleWebSearch, onToggleThinking })
    const web = screen.getByRole('button', { name: /web search: auto/i })
    const brain = screen.getByRole('button', { name: /reasoning effort: auto/i })
    expect(web).toBeInTheDocument()
    expect(brain).toBeInTheDocument()
    // Cycle the web tri-state: auto → on → off → auto.
    fireEvent.click(web)
    expect(onToggleWebSearch).toHaveBeenCalledWith('on')
    renderComposer({ webSearch: 'on', onToggleWebSearch, onToggleThinking })
    fireEvent.click(screen.getByRole('button', { name: /web search: on/i }))
    expect(onToggleWebSearch).toHaveBeenCalledWith('off')
    renderComposer({ webSearch: 'off', onToggleWebSearch, onToggleThinking })
    fireEvent.click(screen.getByRole('button', { name: /web search: off/i }))
    expect(onToggleWebSearch).toHaveBeenCalledWith('auto')
    // effort: open the menu (aria-expanded), then a menuitem dispatches.
    fireEvent.click(brain)
    expect(brain.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByTitle(/^Reasoning effort: Low /))
    expect(onToggle).toHaveBeenCalledWith('low')
  })

  it('effort selector: all six positions, xhigh carries the 8k cap, pick dispatches', () => {
    const onToggle = vi.fn()
    renderComposer({ thinking: 'xhigh', onToggle })
    const btn = screen.getByTitle(/^Reasoning effort: XHigh /)
    fireEvent.click(btn)
    for (const id of ['auto', 'low', 'medium', 'high', 'xhigh', 'off'] as const) {
      expect(screen.getByTitle(new RegExp(`^Reasoning effort: ${id[0].toUpperCase()}${id.slice(1)} `))).toBeInTheDocument()
    }
    for (const next of ['auto', 'low', 'medium', 'high', 'xhigh', 'off'] as const) {
      const item = screen.getByTitle(new RegExp(`^Reasoning effort: ${next[0].toUpperCase()}${next.slice(1)} `))
      fireEvent.click(item)
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

raw = raw[:start] + new_range + raw[end:]
open(p, 'wb').write(raw.replace('\n', '\r\n').encode('utf-8'))
print('ok, range was', len(rng), 'B')
