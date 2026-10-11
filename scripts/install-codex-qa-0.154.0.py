import os,stat,hashlib,subprocess
SOURCE='/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
TARGET='/opt/colo-codex-qa/0.154.0/bin/codex'
SHA='4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc'
assert os.geteuid()==0, 'HOLD: root required'
def checked(p,directory):
 s=os.lstat(p);assert s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and s.st_mode&0o022==0 and (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)), 'HOLD: target metadata'
 out=subprocess.check_output(['/bin/ls','-lde',p],env={'PATH':'/usr/bin:/bin'},text=True).strip();assert len(out.splitlines())==1 and '+' not in out.split()[0], 'HOLD: target ACL'
def digest(fd):
 h=hashlib.sha256()
 while True:
  b=os.read(fd,1024*1024)
  if not b:break
  h.update(b)
 return h.hexdigest()
for p in ['/', '/opt']:checked(p,True)
f=os.open(SOURCE,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC);s=os.fstat(f)
assert stat.S_ISREG(s.st_mode) and s.st_uid==501 and s.st_nlink==1 and s.st_mode&0o022==0 and s.st_size==222655232, 'HOLD: official source metadata'
assert digest(f)==SHA, 'HOLD: official source SHA'
assert 'com.apple.quarantine' not in os.listxattr(SOURCE), 'HOLD: source quarantined; do not strip'
for p in ['/opt/colo-codex-qa','/opt/colo-codex-qa/0.154.0','/opt/colo-codex-qa/0.154.0/bin']:
 try:os.mkdir(p,0o755)
 except FileExistsError:pass
 checked(p,True)
if os.path.lexists(TARGET):
 checked(TARGET,False);d=os.open(TARGET,os.O_RDONLY|os.O_NOFOLLOW);assert os.fstat(d).st_nlink==1 and digest(d)==SHA,'HOLD: existing target';os.close(d)
else:
 temp=TARGET+'.stage';d=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.lseek(f,0,0);h=hashlib.sha256()
 try:
  while True:
   b=os.read(f,1024*1024)
   if not b:break
   h.update(b);view=memoryview(b)
   while view:view=view[os.write(d,view):]
  a=os.fstat(f);assert h.hexdigest()==SHA and (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns),'HOLD: source changed'
  os.fsync(d);os.fchmod(d,0o555);os.close(d);d=None;os.link(temp,TARGET);os.unlink(temp)
 finally:
  if d is not None:os.close(d)
  if os.path.lexists(temp):os.unlink(temp)
os.close(f);checked(TARGET,False)
subprocess.run(['/usr/bin/codesign','--verify','--strict',TARGET],check=True,env={'PATH':'/usr/bin:/bin'},capture_output=True)
version=subprocess.check_output([TARGET,'--version'],env={'HOME':'/var/empty','PATH':'/usr/bin:/bin'},text=True,timeout=15).strip();assert version=='codex-cli 0.154.0','HOLD: version'
print('CODE_SIGNATURE_VERIFIED_VERSION '+version)
print('CODE_INSTALLED_ONLY '+TARGET+' sha256='+SHA)
