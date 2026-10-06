p = 'app/components/chat/__tests__/Composer.test.tsx'
s = open(p, 'rb').read().decode('utf-8')
old = "const brain = screen.getByRole('button', { name: /extended thinking: off/i })"
new = "const brain = screen.getByRole('button', { name: /reasoning effort: off/i })"
assert s.count(old) == 1
open(p, 'wb').write((s[:s.find(old)] + new + s[s.find(old)+len(old):]).encode('utf-8'))
print('ok')
