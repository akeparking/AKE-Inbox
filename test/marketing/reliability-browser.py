"""Local browser regressions; no external customers, CRM or advertising calls."""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

runtime = Path(os.environ['LOCAL_RUNTIME_ROOT'])
output = Path(os.environ['RELIABILITY_OUTPUT'])
users = json.loads((runtime / 'private/accounts.json').read_text())
results = []

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ['CHROMIUM_PATH'], args=['--no-sandbox'])
        async def check(key, title, fn):
            context = await browser.new_context()
            page = await context.new_page()
            try:
                await fn(page)
                results.append({'id':key,'name':title,'status':'passed'})
            except Exception as error:
                results.append({'id':key,'name':title,'status':'failed','error':str(error)[:350]})
            finally:
                await context.close()
                output.write_text(json.dumps(results,ensure_ascii=False,indent=2))
                print(key, results[-1]['status'], flush=True)

        async def delayed_choice(page, denied=False):
            await page.route('**/collector.js*', lambda route: route.abort())
            await page.goto('http://localhost:14626/')
            await page.get_by_role('button',name='允许浏览分析',exact=True).click()
            if denied:
                await page.get_by_role('button',name='拒绝 / 撤回分析',exact=True).click()
            await page.unroute('**/collector.js*')
            await page.add_script_tag(url='/wp-content/plugins/ake-marketing/collector.js')
            await page.wait_for_function('!!window.AKEMarketing?.getState')
            expected = 'denied' if denied else 'granted'
            await page.wait_for_function('(s)=>AKEMarketing.getState().consent.analytics===s', arg=expected,timeout=4000)
            if denied:
                assert await page.evaluate('AKEMarketing.getState().visitorId') is None
            else:
                await page.wait_for_function('!!AKEMarketing.getState().visitorId',timeout=6000)
                assert await page.evaluate('AKEMarketing.getState().consent.adUserData') == 'denied'

        await check('R01','WordPress 延迟加载保留首次分析同意',delayed_choice)
        await check('R02','延迟期间先同意再撤回仅保留最后选择',lambda page:delayed_choice(page,True))

        async def rapid_navigation(page):
            await page.goto('http://localhost:14621/')
            await page.get_by_role('button',name='允许分析',exact=True).click()
            await page.wait_for_function('!!AKEMarketing.getState().visitorId')
            await page.evaluate('AKEMarketing.flush()')
            async def slow(route):
                await asyncio.sleep(.25)
                await route.continue_()
            await page.route('**/public/events',slow)
            await page.evaluate("""() => { for (const name of ['one','two','three']) {
                document.title='Fictional '+name;
                history.pushState({},'', '/spa/reliability-'+name);
            }}""")
            visitor = await page.evaluate('AKEMarketing.getState().visitorId')
            rows = []
            for _ in range(45):
                response = await page.request.post('http://localhost:14620/api/v1/accounts/1/ake_marketing/visitor',
                    headers={'api_access_token':users['users']['admin']['token']},data={'input':{'id':visitor}})
                assert response.ok
                rows = [e['data'] for e in (await response.json())['events'] if e['event_type']=='page_view']
                if len(rows)>=4: break
                await asyncio.sleep(.2)
            paths=[row['pageUrl'].split(':14621')[-1] for row in rows]
            assert paths==['/','/spa/reliability-one','/spa/reliability-two','/spa/reliability-three'],paths
            assert [row['title'] for row in rows[1:]]==['Fictional one','Fictional two','Fictional three']
            await page.add_script_tag(url='/collector.js')
            await asyncio.sleep(.3)
            await page.screenshot(path=str(output.parent/'rapid-navigation.png'))
        await check('R03','慢网络下连续 SPA 导航按顺序保存且不重复',rapid_navigation)
        async def boundary(page, preconsent=False):
            await page.goto('http://localhost:14621/')
            await page.wait_for_function('!!window.AKEMarketing?.getState')
            if not preconsent:
                await page.get_by_role('button',name='允许分析',exact=True).click()
                await page.wait_for_function('!!AKEMarketing.getState().visitorId')
                await page.evaluate('AKEMarketing.flush()')
            await page.evaluate("""async (preconsent) => {
                document.title='Private excluded page';history.pushState({},'', '/login');
                document.title='Public product';history.pushState({},'', '/products/after-boundary');
                if(preconsent)await AKEMarketing.setConsent({analytics:'granted',adStorage:'denied',adUserData:'denied',adPersonalization:'denied'});
            }""",preconsent)
            await page.wait_for_function('!!AKEMarketing.getState().visitorId')
            visitor=await page.evaluate('AKEMarketing.getState().visitorId')
            for _ in range(40):
                response=await page.request.post('http://localhost:14620/api/v1/accounts/1/ake_marketing/visitor',headers={'api_access_token':users['users']['admin']['token']},data={'input':{'id':visitor}})
                events=(await response.json())['events'];views=[e['data'] for e in events if e['event_type']=='page_view']
                if any('/after-boundary' in e['pageUrl'] for e in views):break
                await asyncio.sleep(.2)
            assert len(views)==(1 if preconsent else 2)
            assert not any('/login' in e['data'].get('pageUrl','') or e['data'].get('title')=='Private excluded page' for e in events)
        await check('R04','排除的登录页不因快速导航被采集',boundary)
        await check('R05','同意之前的排队导航不补造为已观察历史',lambda page:boundary(page,True))
        await browser.close()
    if any(row['status']!='passed' for row in results): raise SystemExit(1)

asyncio.run(main())
