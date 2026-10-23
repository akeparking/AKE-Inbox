import asyncio,json,os,pathlib
from playwright.async_api import async_playwright
root=pathlib.Path(os.environ['LOCAL_RUNTIME_ROOT']);users=json.loads((root/'private/accounts.json').read_text());results=[]
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH',p.chromium.executable_path),args=['--no-sandbox'])
  async def check(id,name,fn):
   try:await fn();results.append({'id':id,'name':name,'status':'passed'});print('PASS',id,name,flush=True)
   except Exception as e:results.append({'id':id,'name':name,'status':'failed','error':str(e)[:500]});raise
   finally:(root/'qa/browser-cases.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
  async def newpage(script=None):
   c=await b.new_context(viewport={'width':1280,'height':900})
   if script:await c.add_init_script(script)
   page=await c.new_page();await page.goto('http://localhost:14621/');await page.wait_for_function('!!window.AKEMarketing');return c,page
  async def allow(page):
   await page.get_by_role('button',name='允许分析',exact=True).click();await page.wait_for_function('AKEMarketing.getState().visitorId!==null')
   for _ in range(40):
    if any(e['event_type']=='page_view' for e in (await timeline(page))['events']):break
    await page.wait_for_timeout(100)
  async def timeline(page):
   await page.wait_for_function('!!AKEMarketing.getState().visitorId')
   vid=await page.evaluate('AKEMarketing.getState().visitorId')
   r=await page.request.post('http://localhost:14620/api/v1/accounts/1/ake_marketing/visitor',headers={'api_access_token':users['users']['admin']['token']},data={'input':{'id':vid}});assert r.ok;return await r.json()
  async def persisted_views(page,count):
   for _ in range(100):
    t=await timeline(page)
    if len([e for e in t['events'] if e['event_type']=='page_view'])>=count:return t
    await page.wait_for_timeout(100)
   raise AssertionError('Expected page views were not persisted')
  async def formfill(page):
   await page.locator('input[name=name]').first.fill('Browser fictional visitor');await page.locator('input[name=email]').first.fill('browser@example.invalid');await page.locator('input[name=company]').first.fill('Fictional browser company');await page.locator('textarea[name=message]').first.fill('Browser acceptance fixture only.')
  async def consent():
   c,page=await newpage();assert await page.evaluate('AKEMarketing.getState().visitorId') is None
   await page.get_by_role('button',name='拒绝 / 撤回',exact=True).click();assert await page.evaluate('AKEMarketing.getState().visitorId') is None
   await allow(page);await page.get_by_role('button',name='拒绝 / 撤回',exact=True).click();await page.wait_for_function('AKEMarketing.getState().visitorId===null');assert not await page.evaluate("Object.keys(localStorage).some(k=>k.endsWith('.visitor'))");await c.close()
  await check('B01','同意未知、拒绝、授权与撤回的浏览器行为',consent)
  async def storage():
   c,page=await newpage("Storage.prototype.setItem=function(){throw new DOMException('blocked','SecurityError')};Storage.prototype.getItem=function(){throw new DOMException('blocked','SecurityError')}")
   await allow(page);state=await page.evaluate('AKEMarketing.getState()');assert state['coverage']['storageAvailable'] is False
   await page.reload();await allow(page);assert (await page.evaluate('AKEMarketing.getState().visitorId'))!=state['visitorId'];await c.close()
  await check('B02','存储不可用明确标注，刷新后不假装识别同一人',storage)
  async def spa():
   c,page=await newpage();await allow(page);before=await timeline(page);await page.add_script_tag(url='/collector.js');await page.wait_for_timeout(300);after=await timeline(page);assert len(before['events'])==len(after['events'])
   await page.get_by_role('button',name='SPA 查看另一产品').click();t=await persisted_views(page,2);views=[x for x in t['events'] if x['event_type']=='page_view'];assert len(views)==2;assert '/spa/product-' in views[-1]['data']['pageUrl'];await c.close()
  await check('B03','SPA 导航、重复脚本注入不重复计页面浏览',spa)
  async def dynamic():
   c,page=await newpage();await allow(page);await page.get_by_role('button',name='加载动态表单').click();await page.wait_for_function("document.querySelectorAll('form[data-ake-form]').length===2")
   ids=await page.locator('form[data-ake-form] input').evaluate_all('(xs)=>xs.map(x=>x.id)');assert len(ids)==len(set(ids));await c.close()
  await check('B04','动态表单载入和多个实例字段标识隔离',dynamic)
  async def blocked():
   c=await b.new_context();page=await c.new_page();await page.route('**/collector.js',lambda route:route.abort());await page.goto('http://localhost:14621/');assert await page.evaluate('!!window.AKEMarketing') is False
   await page.unroute('**/collector.js');await page.add_script_tag(url='/collector.js');await allow(page);t=await timeline(page);assert len([e for e in t['events'] if e['event_type']=='page_view'])==1;assert t['visits'][0]['coverage']['history']=='starts_here';await c.close()
  await check('B05','脚本阻断后延迟加载，只记录开始观察后的轨迹',blocked)
  async def retry():
   c,page=await newpage();await allow(page);await formfill(page);received=[]
   async def lost_response(route):
    r=await route.fetch();received.append(await r.json());await route.abort()
   await page.route('**/public/submissions',lost_response,times=1);await page.get_by_role('button',name='Send inquiry',exact=True).click();await page.wait_for_function("!document.querySelector('form button[type=submit]').disabled");assert len(received)==1 and received[0]['confirmed']
   await page.get_by_role('button',name='Send inquiry',exact=True).click();await page.get_by_role('status').filter(has_text='Your inquiry has been received').wait_for();assert received[0]['inquiryId'][:8] in await page.get_by_role('status').inner_text();await c.close()
  await check('B06','后端已收件但浏览器丢失响应，重试保持同一询盘',retry)
  async def wordpress():
   c=await b.new_context();page=await c.new_page();await page.goto('http://localhost:14626/');await page.wait_for_function('!!window.AKEMarketing');await page.get_by_role('button',name='允许浏览分析',exact=True).click();await page.wait_for_function('AKEMarketing.getState().visitorId!==null');await formfill(page);await page.get_by_role('button',name='Send inquiry',exact=True).click();await page.get_by_role('status').filter(has_text='Your inquiry has been received').wait_for();await page.screenshot(path=str(root/'qa/wordpress-plugin.png'),full_page=True);await c.close()
  await check('B07','真实本地 WordPress 插件安装、同意选择、表单收件',wordpress)
  async def agent():
   c=await b.new_context();page=await c.new_page();await page.goto('http://localhost:14620/app/login');await page.locator('input[name=email_address]').fill(users['users']['agent-a']['email']);await page.locator('input[type=password]').fill(users['users']['agent-a']['password']);await page.get_by_role('button',name='Login',exact=True).click();await page.wait_for_url('**/app/accounts/**',timeout=60000);await page.goto('http://localhost:14620/ake/marketing?account=1');await page.get_by_role('heading',name='询盘',exact=True).wait_for();assert await page.locator('#tabs button').count()==1;await page.screenshot(path=str(root/'qa/agent-scope.png'),full_page=True);await c.close()
  await check('B08','普通坐席的真实浏览器入口仅展示授权询盘',agent)
  async def invalid():
   c,page=await newpage();await allow(page);await page.get_by_role('button',name='Send inquiry',exact=True).click();await page.wait_for_timeout(400);await page.evaluate('AKEMarketing.flush()');t=await timeline(page);assert len([e for e in t['events'] if e['event_type']=='form_submit_attempt'])==1;assert not await page.get_by_role('status').inner_text();await c.close()
  await check('B09','必填校验失败只记录一次尝试，不显示收件成功',invalid)
  async def idle_tab():
   c,page=await newpage();await page.clock.install();await allow(page);old=await page.evaluate('AKEMarketing.getState().visitId');await page.evaluate("window.testVisibility='hidden';Object.defineProperty(document,'visibilityState',{get:()=>window.testVisibility,configurable:true});document.dispatchEvent(new Event('visibilitychange'))")
   await page.clock.fast_forward(31*60*1000);await page.evaluate("window.testVisibility='visible';document.dispatchEvent(new Event('visibilitychange'))");await page.wait_for_function('(old)=>!!AKEMarketing.getState().visitId&&AKEMarketing.getState().visitId!==old',arg=old);t=await persisted_views(page,2);assert len(t['visits'])==2;assert len([e for e in t['events'] if e['event_type']=='page_view'])==2;assert sum(e['data'].get('activeMs',0) for e in t['events'])<60000;await c.close()
  await check('B10','隐藏标签页超过 30 分钟后新访次，隐藏时间不算停留',idle_tab)
  await b.close()
asyncio.run(main())
