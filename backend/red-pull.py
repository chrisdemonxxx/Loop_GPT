#!/usr/bin/env python3
import subprocess, os
out = subprocess.run(['git', '-C', os.getcwd(), 'ls-tree', '-z', 'HEAD', '../backend/src/'], capture_output=True)
recs = [r for r in out.stdout.split(b'\x00') if r]
print('recs:', len(recs))
for r in recs:
    print(r.decode('utf-8', 'replace')[:70])
rec = next(r for r in recs if b'chatModel.test' in r)
meta, p = rec.split(b'\t', 1)
print('mode:', meta.decode())
print('path hex:', p.hex())
print('U+2028 at:', p.find(b'\xe2\x80\xa8'))
oid = meta.split()[2]
old = subprocess.run(['git', '-C', os.getcwd(), 'cat-file', 'blob', oid], capture_output=True).stdout
import hashlib
print('IDX blob', len(old), 'B', hashlib.sha256(old).hexdigest()[:40])
T = os.environ['LOCALAPPDATA'] + r'\Temp'
os.makedirs(T, exist_ok=True)
open(T + r'\red-old', 'wb').write(old)
F = os.path.join(os.getcwd(), 'backend', 'src', p)
new = open(F, 'rb').read()
print('WORK', len(new), 'B', hashlib.sha256(new).hexdigest()[:40])
open(T + r'\red-new', 'wb').write(new)
