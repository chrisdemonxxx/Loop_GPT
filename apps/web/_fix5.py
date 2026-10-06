p = 'app/components/chat/__tests__/Composer.test.tsx'
raw = open(p, 'rb').read()
s = raw.decode('utf-8')
s = s.replace('\r\n', '\n')

old = """    // The effort button opens the menu; picking Low dispatches it.
    fireEvent.click(brain)
    expect(onToggle).toHaveBeenCalledWith('low')"""
new = """    // The effort button opens the menu (aria-expanded), then the menuitem dispatches.
    fireEvent.click(brain)
    expect(brain.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByTitle(/^Reasoning effort: Low /))
    expect(onToggle).toHaveBeenCalledWith('low')"""
assert s.count(old) == 1

old2 = """    for (const next of ['auto', 'low', 'medium', 'high', 'xhigh', 'off'] as const) {
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${next[0].toUpperCase()}${next.slice(1)}$`, 'i')}))
      expect(onToggle).toHaveBeenCalledWith(next)
    }"""
new2 = """    for (const next of ['auto', 'low', 'medium', 'high', 'xhigh', 'off'] as const) {
      const item = screen.getByTitle(new RegExp(`^Reasoning effort: ${next[0].toUpperCase()}${next.slice(1)} `))
      fireEvent.click(item)
      expect(onToggle).toHaveBeenCalledWith(next)
    }"""
assert s.count(old2) == 1

s = s.replace(old, new).replace(old2, new2)
# CRLF file
open(p, 'wb').write(s.replace('\n', '\r\n').encode('utf-8'))
print('ok')
