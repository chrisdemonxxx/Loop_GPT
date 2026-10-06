import subprocess, os, hashlib
ROOT = os.getcwd()
T = os.environ['LOCALAPPDATA'] + '\Temp'
def sha(b): return hashlib.sha256(b).hexdigest()
out = subprocess.run(['git','-C',ROOT,'ls-tree','-z','HEAD','src/'], capture_output=True)
rec = next(r for r in out.stdout.split(b'\x00') if b'\xe2\x80\xa8' in r)
meta, p = rec.split(b'\t', 1)
oid = meta.split()[2]
old = subprocess.run(['git','-C',ROOT,'cat-file','blob',oid], capture_output=True).stdout
print('IDX', len(old), 'B', sha(old)[:40])
F = os.path.join(ROOT, p)
new = open(F, 'rb').read()
print('WORK', len(new), 'B', sha(new)[:40])
open(T+'\red-old','wb').write(old)
open(T+'\red-new','wb').write(new))
print('name', p)
