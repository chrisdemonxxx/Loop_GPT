import subprocess, os, hashlib, base64
D = os.getcwd()
T = os.environ['LOCALAPPDATA'] + '\Temp'
def sha(b): return hashlib.sha256(b).hexdigest()
# 1) get the staged blob (U+2028 name)
lst = subprocess.run(['git','-C',D,'ls-files','-z','src/'], capture_output=True)
recs = [r for r in lst.stdout.split(b'\x00') if r]
rec = next(r for r in recs if b'\xe2\x80\xa8' in r)
meta, p = rec.split(b'\x00', 1) and rec.split(b'\x00', 1)
meta, p = rec.split(b'\x00', 1)
m = meta.split()
print('mode', m[0], 'oid', m[1])
old = subprocess.run(['git','-C',D,'cat-file','blob',m[1]], capture_output=True).stdout
print('IDX test', len(old), 'B', sha(old)[:40])
# 2) worktree
F = os.path.join(D,'src',p)
new = open(F,'rb').read()
print('WORK test', len(new), 'B', sha(new)[:40])
open(T+'\red-old','wb').write(old)
open(T+'\red-new','wb').write(new)
open(T+'\red-pname.bin','wb').write(p))
