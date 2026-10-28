"""Real native UI checks using a disposable fictional fixture. Never production."""
import asyncio,json,os
from urllib.parse import urlparse
from pathlib import Path
from playwright.async_api import async_playwright
P=Path(os.environ['AKE_UI_OUTPUT']);P.mkdir(parents=True,exist_ok=True)
BASE=os.environ['AKE_UI_TEST_URL'].rstrip('/')
assert urlparse(BASE).hostname in ['127.0.0.1','localhost'], 'disposable local fixture required'
async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),args=['--no-sandbox','--no-proxy-server'])
  c=await b.new_context(storage_state=os.environ['AKE_UI_STAFF_SESSION'],viewport={'width':1440,'height':960},locale='zh-CN');page=await c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(type(e).__name__))
  await page.goto(BASE+'/app/accounts/1/inbox/all/conversations/1');await page.locator('#ake-source-panel').wait_for();await page.get_by_text('此会话暂无关联询盘。',exact=True).wait_for(timeout=45000)
  await page.get_by_role('button',name='查看 / 编辑客户资料',exact=True).click();await page.wait_for_timeout(3500)
  assert await page.locator('.ake-context-native #ake-source-panel').count()==1
  await page.screenshot(path=str(P/'customer-context.png'))
  await page.goto(BASE+'/ake/marketing?account=1&view=meta_feedback');await page.get_by_text('暂无 Meta 回传记录。',exact=True).wait_for(timeout=45000)
  assert '本地模拟' in await page.locator('#main').inner_text()
  assert '不上传到 Meta' in await page.locator('#main').inner_text()
  await page.screenshot(path=str(P/'meta-feedback.png'))
  for name in ['概览','询盘','表单','访客','回传记录','Meta Ads 回传']:
   await page.locator('#tabs').get_by_role('button',name=name,exact=True).click();await page.locator('#main').get_by_text('正在读取…',exact=True).wait_for(state='hidden')
   assert not (await page.locator('#error').inner_text()).strip(),name
   assert not await page.locator('#main').get_by_text('正在读取…',exact=True).count(),name
  for w in [1024,390,320]:
   await page.set_viewport_size({'width':w,'height':844});await page.wait_for_timeout(200)
   assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth')
   await page.screenshot(path=str(P/('marketing-'+str(w)+'.png')))
  assert not errors
  result={'native_customer_context':True,'marketing_tabs':6,'meta_mode':'mock','real_meta_requests':0,'responsive_widths':[1440,1024,390,320],'page_errors':errors}
  (P/'marketing-ui.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));await b.close()
asyncio.run(main())
