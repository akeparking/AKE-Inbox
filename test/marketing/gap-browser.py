import asyncio,json,os,pathlib
from playwright.async_api import async_playwright
root=pathlib.Path(os.environ['LOCAL_RUNTIME_ROOT']);users=json.loads((root/'private/accounts.json').read_text());results=[]
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH',p.chromium.executable_path),args=['--no-sandbox']);context=await browser.new_context(viewport={'width':1280,'height':900});page=await context.new_page()
  async def api(action,input={}):
   r=await page.request.post('http://localhost:14620/api/v1/accounts/1/ake_marketing/'+action,headers={'api_access_token':users['users']['admin']['token']},data={'input':input});assert r.ok,(action,r.status);return await r.json()
  async def check(id,name,fn):
   try:await fn();results.append({'id':id,'name':name,'status':'passed'});print('PASS',id,name,flush=True)
   except Exception as e:results.append({'id':id,'name':name,'status':'failed','error':str(e)[:400]});raise
   finally:(root/'qa/gap-browser.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
  async def iframe():
   await page.goto('http://localhost:14621/products/guidance?utm_source=iframe-fixture');await page.get_by_role('button',name='允许分析',exact=True).click();await page.wait_for_function('!!AKEMarketing.getState().visitorId');vid=await page.evaluate('AKEMarketing.getState().visitorId');before=(await api('overview'))['totals']['inquiries']
   await page.evaluate("""()=>{const f=document.createElement('iframe');f.id='third-party-form';f.title='独立域表单';f.src='http://127.0.0.1:14629/';f.width='600';f.height='260';AKEMarketing.connectFrame(f,{origin:'http://127.0.0.1:14629',formId:'a0000000-0000-4000-8000-000000000001'});document.querySelector('main').prepend(f);} """)
   f=page.frame_locator('#third-party-form');await f.get_by_role('status').filter(has_text='表单已就绪').wait_for()
   await page.evaluate("postMessage({type:'AKE_FORM_SUCCESS',inquiryId:'forged'},location.origin)");assert (await api('overview'))['totals']['inquiries']==before
   await f.locator('textarea').fill('Persisted cross-origin fictional project inquiry.');await f.get_by_role('button',name='提交独立域表单').click();await f.get_by_role('status').filter(has_text='已持久收件').wait_for();frame=next(x for x in page.frames if x.url.startswith('http://127.0.0.1:14629'));receipt=await frame.evaluate('window.receipt');inquiry=await api('inquiry',{'id':receipt['inquiryId']});assert inquiry['inquiry']['visitor_id']==vid;assert inquiry['inquiry']['source_kind']=='backend_form'
   await f.get_by_role('button',name='提交独立域表单').click();await page.wait_for_timeout(400);assert (await api('overview'))['totals']['inquiries']==before+1;await page.locator('main').screenshot(path=str(root/'qa/cross-origin-form.png'))
   for _ in range(100):
    inquiry=await api('inquiry',{'id':receipt['inquiryId']})
    if inquiry['inquiry']['message_id']:break
    await page.wait_for_timeout(300)
   assert inquiry['inquiry']['message_id'];(root/'private/frame-browser-inquiry.json').write_text(json.dumps({'id':receipt['inquiryId'],'visitorId':vid,'conversationId':inquiry['inquiry']['conversation_id']}))
  await check('GB01','跨域 iframe：真实浏览器、后端持久收件、签名回执、来源关联与重复提交',iframe)
  async def invalid():
   frame=next(x for x in page.frames if x.url.startswith('http://127.0.0.1:14629'));before=(await api('overview'))['totals']['inquiries'];status=await frame.evaluate("async()=>{const r=await fetch('/receipt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({submission:crypto.randomUUID(),message:''})});return r.status}");assert status==422;assert (await api('overview'))['totals']['inquiries']==before
   await page.evaluate("()=>{window.spoofContextReceived=false;addEventListener('message',e=>{if(e.data?.type==='AKE_FORM_CONTEXT')window.spoofContextReceived=true});postMessage({type:'AKE_FORM_READY',challenge:crypto.randomUUID()},location.origin)}");await page.wait_for_timeout(300);assert not await page.evaluate('spoofContextReceived')
  await check('GB02','无效表单不建档；伪造窗口的上下文请求及成功通知无效',invalid)
  async def native():
   await page.goto('http://localhost:14620/app/login');await page.locator('input[name=email_address]').fill(users['users']['admin']['email']);await page.locator('input[type=password]').fill(users['users']['admin']['password']);await page.get_by_role('button',name='Login',exact=True).click();await page.wait_for_url('**/app/accounts/**',timeout=60000)
   await page.goto('http://localhost:14620/ake/marketing?account=1&view=visitors');await page.get_by_role('heading',name='访客',exact=True).wait_for();await page.get_by_text('第 1 页',exact=False).first.wait_for()
   assert await page.get_by_role('button',name='下一页',exact=True).count()==2
   if await page.get_by_role('button',name='下一页',exact=True).count():
    await page.get_by_role('button',name='下一页',exact=True).first.click();await page.get_by_text('第 2 页',exact=False).first.wait_for();await page.get_by_role('button',name='上一页',exact=True).first.click();await page.get_by_text('第 1 页',exact=False).first.wait_for()
   await page.screenshot(path=str(root/'qa/marketing-pagination-desktop.png'));await page.set_viewport_size({'width':390,'height':844});await page.screenshot(path=str(root/'qa/marketing-pagination-mobile.png'));assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   item=json.loads((root/'private/frame-browser-inquiry.json').read_text());await page.goto('http://localhost:14620/ake/marketing?account=1&inquiry='+item['id']);await page.get_by_role('button',name='关联另一个渠道',exact=True).click();await page.get_by_role('button',name='确认关联',exact=True).click();await page.locator('dialog [role=alert]').filter(has_text='核对').wait_for();await page.get_by_role('button',name='取消',exact=True).click();await page.locator('dialog').wait_for(state='detached')
  await check('GB03','原生营销分页、手机布局与关联对话框校验',native)
  async def late_consent():
   c=await browser.new_context();q=await c.new_page();await q.goto('http://localhost:14621/iframe');f=q.frame_locator('#embedded-form');await f.get_by_role('status').filter(has_text='表单已就绪').wait_for();frame=next(x for x in q.frames if x.url.startswith('http://127.0.0.1:14629'));old=await frame.evaluate('context.token');assert await q.evaluate('AKEMarketing.getState().visitorId') is None
   await q.get_by_role('button',name='允许分析',exact=True).click();await frame.wait_for_function('(old)=>context.token!==old',arg=old,polling=100);vid=await q.evaluate('AKEMarketing.getState().visitorId');await f.locator('textarea').fill('Fictional iframe inquiry after later consent.');await f.get_by_role('button',name='提交独立域表单').click();await f.get_by_role('status').filter(has_text='已持久收件').wait_for();receipt=await frame.evaluate('window.receipt');assert (await api('inquiry',{'id':receipt['inquiryId']}))['inquiry']['visitor_id']==vid;await c.close()
  await check('GB04','页面先加载 iframe 后同意分析，重新签发上下文并关联正确访客',late_consent)
  await browser.close()
asyncio.run(main())
