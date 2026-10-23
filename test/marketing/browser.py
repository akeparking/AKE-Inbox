import asyncio,json,os,pathlib,time
from playwright.async_api import async_playwright
runtime=pathlib.Path(os.environ['LOCAL_RUNTIME_ROOT'])
accounts=json.loads((runtime/'private/accounts.json').read_text())
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH',p.chromium.executable_path),headless=True,args=['--no-sandbox'])
  context=await browser.new_context(viewport={'width':1440,'height':1000});page=await context.new_page();errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)[:150]))
  await page.goto('http://localhost:14621/?utm_source=google&utm_medium=cpc&utm_campaign=local-test&gclid=fictional_click_local_only')
  await page.get_by_role('button',name='允许分析和广告数据',exact=True).click()
  await page.wait_for_function('AKEMarketing.getState().visitorId !== null')
  visitor=await page.evaluate('AKEMarketing.getState().visitorId')
  await page.get_by_role('link',name='引导系统',exact=True).click();await page.wait_for_function('AKEMarketing.getState().visitorId !== null')
  assert await page.evaluate('AKEMarketing.getState().visitorId')==visitor
  await page.get_by_role('link',name='收费系统',exact=True).click();await page.wait_for_function('AKEMarketing.getState().visitorId !== null')
  await page.locator('input[name=name]').fill('Fictional QA Visitor');await page.locator('input[name=email]').fill('qa@example.invalid');await page.locator('input[name=company]').fill('Fictional QA Company');await page.locator('textarea[name=message]').fill('Local acceptance inquiry for parking guidance. No external delivery.')
  await page.get_by_role('button',name='Send inquiry',exact=True).click()
  await page.get_by_role('status').filter(has_text='Your inquiry has been received').wait_for()
  await page.screenshot(path=str(runtime/'qa/test-site.png'),full_page=True)
  admin=await context.new_page();await admin.goto('http://localhost:14620/app/login')
  await admin.locator('input[name=email_address]').fill(accounts['users']['admin']['email']);await admin.locator('input[type=password]').fill(accounts['users']['admin']['password']);await admin.get_by_role('button',name='Login',exact=True).click()
  await admin.wait_for_url('**/app/accounts/**',timeout=60000)
  await admin.goto('http://localhost:14620/ake/marketing?account='+str(accounts['accountId']))
  await admin.get_by_role('heading',name='营销概览',exact=False).wait_for(timeout=30000)
  await admin.screenshot(path=str(runtime/'qa/marketing-desktop.png'),full_page=True)
  await admin.get_by_role('button',name='询盘',exact=True).click();await admin.wait_for_timeout(1500)
  await admin.screenshot(path=str(runtime/'qa/marketing-inquiries.png'),full_page=True)
  await admin.set_viewport_size({'width':390,'height':844});await admin.screenshot(path=str(runtime/'qa/marketing-mobile.png'),full_page=True)
  (runtime/'qa/browser-smoke.json').write_text(json.dumps({'visitorId':visitor,'browserErrors':errors,'result':'passed'},ensure_ascii=False,indent=2))
  await browser.close();print('Browser smoke passed')
asyncio.run(main())
