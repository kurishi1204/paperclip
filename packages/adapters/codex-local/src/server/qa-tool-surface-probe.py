"""Offline CLI tool-surface proof: fake MCP/provider, no real credential or network egress."""
import http.server,threading,tempfile,subprocess,os,json,pathlib,sys
root=pathlib.Path(tempfile.mkdtemp(prefix='codex-qa-surface-')); captured=[]
spec=json.loads(pathlib.Path(sys.argv[1]).read_text()); assert 'binary' not in spec, 'custom runtime forbidden'; tools=spec['tools']; args=spec['args']
class H(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  q=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  print('FIXTURE_POST_PATH',self.path,flush=True)
  if self.path=='/mcp':
   if 'id' not in q:self.send_response(202);self.end_headers();return
   method=q.get('method')
   if method not in ('initialize','tools/list','tools/call'):
    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'jsonrpc':'2.0','id':q['id'],'error':{'code':-32601,'message':'Method not found'}}).encode());return
   result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}} if method=='initialize' else {'tools':[{'name':n,'description':'fixture QA tool','inputSchema':{'type':'object','properties':{}}} for n in tools]} if method=='tools/list' else {'content':[{'type':'text','text':'fixture QA evidence'}], 'isError':False}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':result}).encode());return
  captured.append(q)
  child = any(i.get('role')=='user' and 'Reply fixture.' in json.dumps(i.get('content',[])) for i in q.get('input',[]))
  print('FIXTURE_REQUEST',len(captured),'inputitems',len(q.get('input',[])),flush=True)
  if spec.get('inventory') and (len(captured)==1 or spec.get('childInventory') and not any(i.get('type','').endswith('_output') and i.get('call_id')=='call-fixture' for i in q.get('input',[]))):
   item={'id':'ct-fixture','type':'custom_tool_call','call_id':'call-fixture','name':'exec','namespace':'functions','input':spec.get('fixtureCode','text(ALL_TOOLS.map(x => x.name))')}
   item.update(spec.get('fixtureTool',{})) if len(captured)==1 else item.update({'input':spec.get('childFixtureCode','text({tools:ALL_TOOLS.map(x=>x.name),shell:typeof tools.exec_command})')})
   response={'id':'resp-fixture','object':'response','status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
   events=[('response.created',{'response':{**response,'status':'in_progress','output':[]}}),('response.output_item.added',{'output_index':0,'item':item}),('response.output_item.done',{'output_index':0,'item':item}),('response.completed',{'response':response})]
   self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
   for name,data in events:self.wfile.write(('event: '+name+'\ndata: '+json.dumps({'type':name,**data})+'\n\n').encode());self.wfile.flush()
   return
  if spec.get('childInventory') and not child:
   import time;time.sleep(8)
  self.send_response(400);self.end_headers();self.wfile.write(b'{"error":{"message":"probe complete"}}')
 def do_GET(self):
  print('FIXTURE_GET_PATH',self.path,flush=True);self.send_response(405);self.end_headers()
 def log_message(self,*a):pass
srv=http.server.ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=srv.serve_forever,daemon=True).start()
home=root/'codex';home.mkdir(mode=0o700)
(home/'config.toml').write_text('[mcp_servers.paperclip_qa]\nurl='+json.dumps('http://127.0.0.1:'+str(srv.server_port)+'/mcp')+'\nbearer_token_env_var="PAPERCLIP_QA_TOKEN"\nenabled_tools='+json.dumps(tools)+'\n'+''.join('[mcp_servers.paperclip_qa.tools.'+n+']\napproval_mode="approve"\n' for n in tools))
prefix=['-c','model_provider="probe"','-c','model_providers.probe.name="probe"','-c',f'model_providers.probe.base_url="http://127.0.0.1:{srv.server_port}/v1"','-c','model_providers.probe.wire_api="responses"','-c','model_providers.probe.env_key="OPENAI_API_KEY"','-c','model_providers.probe.request_max_retries=0']
args=[str(root) if x=='FIXTURE_CWD' else x for x in args]
env={'HOME':str(root),'CODEX_HOME':str(home),'OPENAI_API_KEY':'fixture-not-real','PAPERCLIP_QA_TOKEN':'fixture-not-real','PATH':'/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin'}
if spec.get('appServer'):
 import queue,time
 proc=subprocess.Popen(['/opt/homebrew/bin/codex']+prefix+['app-server','--stdio']+(['--code-mode-host','http://127.0.0.1:'+str(srv.server_port)] if spec.get('codeModeHost') else []),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 q=queue.Queue()
 def read():
  for line in proc.stdout:
   try:q.put(json.loads(line))
   except ValueError:pass
 threading.Thread(target=read,daemon=True).start()
 def request(id,method,params):
  proc.stdin.write(json.dumps({'id':id,'method':method,'params':params})+'\n');proc.stdin.flush()
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   m=q.get(timeout=15)
   if m.get('id')==id:
    if 'error' in m:raise RuntimeError(str(m['error']))
    return m['result']
 request(1,'initialize',{'clientInfo':{'name':'qa-fixture','version':'1'},'capabilities':{'experimentalApi':True}})
 proc.stdin.write('{"method":"initialized"}\n');proc.stdin.flush()
 t=request(2,'thread/start',{'cwd':str(root),'model':'gpt-5.6-sol','modelProvider':'probe','sandbox':'read-only','approvalPolicy':'never','environments':[],'ephemeral':True,'dynamicTools':[{'type':'function','name':n,'description':'fixture QA','inputSchema':{'type':'object','properties':{}}} for n in tools]})
 request(3,'turn/start',{'threadId':t['thread']['id'],'input':[{'type':'text','text':'Read assigned issue via QA tools.'}],'environments':[]})
 deadline=time.monotonic()+15
 while not captured and time.monotonic()<deadline:time.sleep(.1)
 proc.terminate();proc.wait(timeout=5)
 class R:stdout='';stderr='probe complete'
 r=R()
else:
 r=subprocess.run(['/opt/homebrew/bin/codex']+prefix+args,input='Read assigned issue using QA MCP.',capture_output=True,text=True,env=env,timeout=35)
print('INVENTORY_OUTPUTS',[i for q in captured for i in q.get('input',[]) if i.get('type','').endswith('_output')]) if spec.get('inventory') else None
print('REQUEST_SHAPES', [{k:type(v).__name__ for k,v in q.items()} for q in captured])
def flatten(items,prefix=''):
 out=[]
 for t in items:
  if t.get('type')=='namespace':out+=flatten(t.get('tools',[]),prefix+t.get('name','')+'.')
  else:out.append(prefix+t.get('name',t.get('type','?')))
 return out
names=[n for q in captured for n in flatten(q.get('tools',[])+[t for i in q.get('input',[]) if i.get('type')=='additional_tools' for t in i.get('tools',[])])]
expected=set(tools) if spec.get('appServer') else {'mcp__paperclip_qa__'+n for n in tools}
print(json.dumps({'requests':len(captured),'toolNames':names,'exactQaOnly':len(captured)==1 and set(names)==expected and len(names)==len(expected),'fixtureFailure':'probe complete' in r.stdout+r.stderr}))
print(r.stdout+r.stderr) if not names else None
# Inventory mode classifies every executor, rather than pretending wrappers are QA tools.
outputs=[i for q in captured for i in q.get('input',[]) if i.get('type','').endswith('_output')]
texts=[c.get('text','') for o in outputs for c in o.get('output',[]) if isinstance(c,dict)]
observations=[]
for value in texts:
 try:observations.append(json.loads(value))
 except (ValueError,TypeError):pass
qa_results={o.get('qaTool') for o in observations if isinstance(o,dict) and o.get('result',{}).get('isError') is False}
denied={o.get('name') for o in observations if isinstance(o,dict) and 'Method not found' in o.get('denied','')}
inventories=[o for o in observations if isinstance(o,dict) and 'inventory' in o]
closed=bool(inventories) and all(set(o['inventory'])==expected|{'apply_patch','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'} and o.get('shell')=='undefined' and set(o.get('globals',{}).values())=={'undefined'} for o in inventories)
closed=closed and qa_results==expected and denied=={'list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'} and any(isinstance(o,dict) and 'writing is blocked by read-only sandbox' in o.get('patchDenied','') for o in observations)
print(json.dumps({'completeExecutorProof':closed,'qaCallbacksSucceeded':len(qa_results),'resourceMethodsDenied':len(denied)}))
srv.shutdown();sys.exit(0 if (closed if spec.get('completeExecutorProof') else len(captured)==1 and set(names)==expected and len(names)==len(expected)) else 1)
