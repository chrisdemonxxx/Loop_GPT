#!/usr/bin/env python3
# RED/GREEN: 8-test file vs old (9345 B) then new (11437 B) module
# test filename is chatModel.test.t + U+2028 + s (p5.js trick)
import subprocess, os, hashlib

D = os.getcwd()
T = os.environ['LOCALAPPDATA'] + '\\Temp'
os.makedirs(T, exist_ok=True)

def sha(b): return hashlib.sha256(b).hexdigest()

def run():
    return subprocess.run(['bash', '-lc', 'npx vitest run src/chatModel.test.ts --reporter=verbose'], capture_output=True)

# locate the U+2028-named test
S = os.path.join(D, 'src')
names = os.listdir(S)
t = next(n for n in names if b'\xe2\x80\xa8' in os.fsencode(n))
T_PATH = os.path.join(S, t)
test = open(T_PATH, 'rb').read()
print('test', len(test), 'B', sha(test)[:40])

old = open(os.path.join(S, 'service-chatModels.ts.bak'), 'rb').read()
print('old module', len(old), 'B', sha(old)[:40])
new = open(os.path.join(S, 'chatModel.ts'), 'rb').read()
print('new module', len(new), 'B', sha(new)[:40])

open(T + '\\red-old-mod', 'wb').write(old)
open(T + '\\red-new-mod', 'wb').write(new)
open(T + '\\red-test', 'wb').write(test)

MOD = os.path.join(S, 'chatModel.ts')
open(MOD, 'wb').write(old)
r1 = run()
open(MOD, 'wb').write(new)
r2 = run()
open(MOD, 'wb').write(new)

def filt(o):
    s = (o.stdout + o.stderr).decode('utf-8', 'replace')
    return '\n'.join(l for l in s.splitlines() if any(k in l for k in (
        'Test Files', 'Tests ', '\u2713', '\u2715', 'Error', 'replace',
        'AssertionError', 'matchObject', 'fallback', 'loop-vision', 'VLM',
        'configured', 'expect', 'received', '\u2193', 'PASS', 'FAIL', 'stdout')))

print('=== RED: old 9345 B + 8 tests ===')
print(filt(r1)); print('RED exit', r1.returncode)
print('=== GREEN: new 11437 B ===')
print(filt(r2)); print('GREEN exit', r2.returncode)
