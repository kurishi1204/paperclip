"""Exercise the real installer quarantine statement without root/host writes."""
import ast,pathlib,subprocess,types,unittest
SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'install-codex-qa-0.154.0.py'
def quarantine_probe(output='',failure=None):
 tree=ast.parse(SCRIPT.read_text())
 functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='assert_no_quarantine']
 if functions:
  nodes=functions+[ast.Expr(value=ast.Call(func=ast.Name(id='assert_no_quarantine',ctx=ast.Load()),args=[ast.Constant(value='fixture-source')],keywords=[]))]
 else:
  nodes=[n for n in tree.body if isinstance(n,ast.Assert) and 'listxattr' in ast.unparse(n.test)]
 calls=[]
 def checked(args,**kwargs):
  calls.append((args,kwargs))
  if failure:raise failure
  return output
 namespace={'os':types.SimpleNamespace(), 'SOURCE':'fixture-source','subprocess':types.SimpleNamespace(check_output=checked)}
 exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),str(SCRIPT),'exec'),namespace)
 return calls
class QuarantineTest(unittest.TestCase):
 def test_python39_without_listxattr_uses_fixed_system_xattr(self):
  calls=quarantine_probe();self.assertEqual(calls[0][0],['/usr/bin/xattr','fixture-source']);self.assertEqual(calls[0][1]['env'],{'PATH':'/usr/bin:/bin'})
 def test_quarantined_source_stops(self):
  with self.assertRaises(AssertionError):quarantine_probe('com.apple.quarantine\n')
 def test_command_failure_stops(self):
  with self.assertRaises(subprocess.CalledProcessError):quarantine_probe(failure=subprocess.CalledProcessError(1,['/usr/bin/xattr']))

class RuntimeClosureTest(unittest.TestCase):
 def test_umask077_new_directories_are_service_traversable(self):
  import os,stat,tempfile
  tree=ast.parse(SCRIPT.read_text());functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='ensure_directory']
  with tempfile.TemporaryDirectory() as root:
   target=os.path.join(root,'new-directory');namespace={'os':os,'stat':stat,'checked':lambda *a:None}
   oldmask=os.umask(0o077)
   try:
    if functions:
     exec(compile(ast.Module(body=functions,type_ignores=[]),str(SCRIPT),'exec'),namespace);namespace['ensure_directory'](target)
    else:
     loops=[n for n in tree.body if isinstance(n,ast.For) and isinstance(n.iter,ast.List) and len(n.iter.elts)==3]
     self.assertEqual(len(loops),1);loop=loops[0];loop.iter=ast.List(elts=[ast.Constant(target)],ctx=ast.Load())
     exec(compile(ast.fix_missing_locations(ast.Module(body=[loop],type_ignores=[])),str(SCRIPT),'exec'),namespace)
   finally:os.umask(oldmask)
   self.assertEqual(stat.S_IMODE(os.lstat(target).st_mode),0o755)
 def test_installer_copies_and_checks_the_required_code_mode_host(self):
  tree=ast.parse(SCRIPT.read_text());calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='install_file']
  self.assertEqual(len(calls),2)
  companion=calls[1];self.assertIn('code-mode-host',ast.unparse(companion.args[0]));self.assertEqual(ast.literal_eval(companion.args[2]),'426d73aaeb2aeef45e98b5add99e8ef9594a31673d281489bb2cb06b38c27423')

if __name__=='__main__':unittest.main()
