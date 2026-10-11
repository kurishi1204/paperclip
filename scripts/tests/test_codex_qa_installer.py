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
if __name__=='__main__':unittest.main()
