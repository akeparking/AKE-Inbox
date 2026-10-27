"""API protocol failure checks. No real API credentials or customer messages."""
import copy,hashlib,hmac,importlib.util,io,json,os,pathlib,tempfile,unittest
from unittest.mock import patch
repo=pathlib.Path(__file__).resolve().parents[2]
tmp=tempfile.TemporaryDirectory();root=pathlib.Path(tmp.name)
(root/'private').mkdir();(root/'deploy').mkdir()
(root/'private/reception-config.json').write_text(json.dumps({'webhook_secret':'fixture-secret','model_api':{'base_url':'https://model.example.invalid/v1','api_key':'fixture-key','model':'fixture-model'}}))
(root/'deploy/reception.schema.json').write_bytes((repo/'deploy/demo/reception.schema.json').read_bytes())
with patch.dict(os.environ,{'SALES_DEMO_ROOT':str(root)}):
 spec=importlib.util.spec_from_file_location('adapter',repo/'deploy/demo/reception.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
value={'reply':'Please share the project location.','summary':'Test only','needsHuman':False,'hasProductClaims':False,'knowledgeIds':[],'askedFields':['projectLocation'],'fields':{k:[] if k=='products' else None for k in m.SCHEMA['properties']['fields']['properties']},'evidence':[]}
def response(v=None,**extra):return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(v or value)},**extra}]}).encode())
class ApiAdapter(unittest.TestCase):
 def test_valid_response_and_header(self):
  with patch.object(m.API_HTTP,'open',return_value=response()) as request:
   self.assertEqual(m.generate({'messages':[]})['mode'],'api')
   req=request.call_args.args[0];self.assertEqual(req.full_url,'https://model.example.invalid/v1/chat/completions');self.assertEqual(req.get_header('Authorization'),'Bearer fixture-key')
 def test_anthropic_gateway_uses_explicit_disabled_thinking(self):
  body={'model':'fixture-returned-model','stop_reason':'end_turn','content':[{'type':'text','text':json.dumps(value)}]}
  with patch.dict(m.CONFIG['model_api'],{'protocol':'anthropic','disable_thinking':True}),patch.object(m.API_HTTP,'open',return_value=io.BytesIO(json.dumps(body).encode())) as request:
   self.assertEqual(m.generate({'messages':[]})['mode'],'api')
   req=request.call_args.args[0];payload=json.loads(req.data)
   self.assertEqual(req.full_url,'https://model.example.invalid/v1/messages')
   self.assertEqual(req.get_header('X-api-key'),'fixture-key');self.assertEqual(req.get_header('Anthropic-version'),'2023-06-01')
   self.assertEqual(payload['thinking'],{'type':'disabled'});self.assertIn('Required JSON schema:',payload['system'])
   self.assertNotIn('Authorization',req.headers);self.assertNotIn('response_format',payload)
   self.assertEqual(m.STATUS['returnedModel'],'fixture-returned-model')
 def test_anthropic_incomplete_and_tool_responses_are_rejected(self):
  for stop,block in [('max_tokens',{'type':'text','text':json.dumps(value)}),('end_turn',{'type':'tool_use','id':'fixture','name':'forbidden','input':{}})]:
   with self.subTest(stop=stop),patch.dict(m.CONFIG['model_api'],{'protocol':'anthropic'}),patch.object(m.API_HTTP,'open',return_value=io.BytesIO(json.dumps({'stop_reason':stop,'content':[block]}).encode())):
    with self.assertRaisesRegex(ValueError,'model_response_incomplete'):m.generate({})
   self.assertFalse(m.MODEL_LOCK.locked())
 def test_unknown_protocol_does_not_send_credentials(self):
  with patch.dict(m.CONFIG['model_api'],{'protocol':'unknown'}),patch.object(m.API_HTTP,'open') as request:
   with self.assertRaisesRegex(ValueError,'model_protocol_invalid'):m.generate({})
   request.assert_not_called()
 def test_string_boolean_rejected_and_lock_released(self):
  v=copy.deepcopy(value);v['needsHuman']='false'
  with patch.object(m.API_HTTP,'open',return_value=response(v)):
   with self.assertRaises(ValueError):m.generate({})
  self.assertFalse(m.MODEL_LOCK.locked())
 def test_truncated_response_rejected(self):
  with patch.object(m.API_HTTP,'open',return_value=response(finish_reason='length')):
   with self.assertRaises(ValueError):m.generate({})
 def test_tool_call_rejected(self):
  with patch.object(m.API_HTTP,'open',return_value=response(message={'content':json.dumps(value),'tool_calls':[{}]})):
   with self.assertRaises(ValueError):m.generate({})
 def test_no_redirect_with_credential(self):
  with self.assertRaises(ValueError):m.NoRedirect().redirect_request(None,None,302,None,None,'https://other.example.invalid')
 def test_webhook_signature_and_expiry(self):
  raw=b'{}';stamp='1792734000';sig='sha256='+hmac.new(b'fixture-secret',stamp.encode()+b'.'+raw,hashlib.sha256).hexdigest();headers={'x-chatwoot-timestamp':stamp,'x-chatwoot-signature':sig}
  self.assertTrue(m.valid_signature(raw,headers,1792734001));self.assertFalse(m.valid_signature(raw,headers,1792734400));self.assertFalse(m.valid_signature(b'changed',headers,1792734001))
if __name__=='__main__':unittest.main()
