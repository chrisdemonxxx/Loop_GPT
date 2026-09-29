p = 'app/components/chat/__tests__/Composer.test.tsx'
s = open(p, 'rb').read().decode('utf-8')
old = """  it('marks explicit toggle states visually (on = terracotta, off = struck)', () => {
    renderComposer({ webSearch: 'on', thinking: 'off' })
    const web = screen.getByRole('button', { name: /web search: on/i })
    const brain = screen.getByRole('button', { name: /reasoning effort: .*-i })"""
new = """  it('marks explicit toggle states visually (on + high = terracotta)', () => {
    renderComposer({ webSearch: 'on', thinking: 'high' })
    const web = screen.getByRole('button', { name: /web search: on/i })
    const brain = screen.getByRole('button', { name: /reasoning effort: high/i })"""
# fallback: match the body between the two markers
i = s.find("  it('marks explicit toggle states")
assert i > 0
j = s.find("  })", i)
assert j > i
new_body = s[i:j]
assert "getByRole('button'" in new_body
s2 = s[:i] + new_body.replace(old[:len(old)] if False else new_body, new_body, 1)
# simplest: replace whole block
s2 = s[:i] + """  it('marks explicit toggle states visually (on + high = terracotta)', () => {
    renderComposer({ webSearch: 'on', thinking: 'high' })
    const web = screen.getByRole('button', { name: /web search: on/i })
    const brain = screen.getByRole('button', { name: /reasoning effort: high/i })
    expect(web.className).toContain('text-[#e79d7f]')
    expect(web.getAttribute('aria-pressed')).toBe('true')
    expect(brain.className).toContain('text-[#e79d7f]')
    expect(brain.getAttribute('aria-pressed')).toBe('true')
  })""" + s[j:]
open(p, 'wb').write(s2.encode('utf-8'))
print('ok', j - i)
