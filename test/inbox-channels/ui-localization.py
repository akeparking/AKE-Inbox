"""UI regression: disposable Chatwoot fixture only; never run against production."""
import asyncio
import json
import os
from pathlib import Path
import re
from urllib.parse import urlencode, urlparse
from playwright.async_api import async_playwright


async def main():
    base = os.environ['AKE_UI_TEST_URL'].rstrip('/')
    assert urlparse(base).hostname in ['127.0.0.1', 'localhost'], 'disposable local fixture required'
    fixture = json.loads(Path(os.environ['AKE_UI_FIXTURE']).read_text())
    output = Path(os.environ['AKE_UI_OUTPUT'])
    output.mkdir(parents=True, exist_ok=True)
    errors, results = [], {}
    async with async_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox', '--no-proxy-server']}
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**options)
        staff = await browser.new_context(viewport={'width':1440,'height':960}, locale='zh-CN')
        desk = await staff.new_page()
        desk.on('pageerror', lambda error: errors.append(type(error).__name__))
        await desk.goto(base + '/app/login', wait_until='domcontentloaded')
        await desk.locator('input[name=email_address]').fill(fixture['email'])
        await desk.locator('input[type=password]').fill(fixture['password'])
        await desk.locator('button[type=submit]').click()
        await desk.wait_for_url('**/app/accounts/**', timeout=45000)
        await desk.goto(base + '/app/accounts/1/inbox/all/conversations/1', wait_until='domcontentloaded')
        status = desk.locator('#ake-reception-status')
        await status.wait_for(timeout=30000)
        await desk.wait_for_timeout(3800)
        assert '全部会话' in await desk.locator('#ake-workspace-nav').inner_text()
        assert '网站' in await desk.locator('#ake-workspace-nav').inner_text()
        assert await desk.locator('html').get_attribute('lang') == 'zh-CN'
        assert 'Calls' not in await desk.locator('body').inner_text()
        previous = await status.get_attribute('aria-pressed')
        await status.click()
        await desk.wait_for_function('(value) => document.querySelector("#ake-reception-status").getAttribute("aria-pressed") !== value', arg=previous)
        await status.click()
        await desk.wait_for_function('(value) => document.querySelector("#ake-reception-status").getAttribute("aria-pressed") === value', arg=previous)
        await desk.screenshot(path=str(output/'staff-desktop.png'))
        for width in [1024,390,320]:
            await desk.set_viewport_size({'width':width,'height':844})
            await desk.wait_for_timeout(250)
            box = await status.bounding_box()
            assert box and box['x'] >= 0 and box['x']+box['width'] <= width, 'reception control clipped'
            assert box['height'] >= 44, 'reception target too small'
            assert not await desk.evaluate('document.documentElement.scrollWidth > innerWidth'), 'staff horizontal overflow'
            await desk.screenshot(path=str(output/f'staff-{width}.png'))
        results['staff'] = {'language':'zh-CN','navigation':True,'presence_toggle':True,'widths':[1440,1024,390,320]}
        print('PASS staff Chinese navigation, presence and responsive widths', flush=True)

        async def english(page):
            assert await page.locator('html').get_attribute('lang') == 'en'
            text = await page.locator('body').inner_text()
            assert not re.search(r'[\u3400-\u9fff]', text), 'Chinese text in customer UI'

        visitor = await browser.new_context(viewport={'width':400,'height':820},locale='zh-CN')
        page = await visitor.new_page()
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        widget_url = base+'/widget?'+urlencode({'website_token':fixture['website_token'],'locale':'zh_CN'})
        await page.goto(widget_url, wait_until='domcontentloaded')
        layer = page.locator('#ake-offline-form')
        await layer.wait_for(state='visible', timeout=30000)
        await english(page)
        assert await page.locator('#app').evaluate('(app)=>app.inert'), 'background not removed from tab order'
        await page.screenshot(path=str(output/'customer-offline.png'))
        submit = layer.locator('button[type=submit]')
        await submit.click()
        assert await layer.locator('[name=email]').evaluate('(field)=>field===document.activeElement')
        assert 'Please enter your work email.' in await layer.inner_text()
        await layer.locator('[name=email]').fill('invalid')
        await layer.locator('[name=message]').fill('   ')
        await submit.click()
        assert 'Please enter a valid email address.' in await layer.inner_text()
        assert 'Please tell us about your project.' in await layer.inner_text()
        await english(page)
        await page.screenshot(path=str(output/'customer-validation.png'))
        await layer.locator('[name=email]').fill('ui-offline@example.invalid')
        await layer.locator('[name=message]').fill('Fictional UI acceptance: parking guidance for a shopping centre.')
        attempts = []
        request_started, release_request = asyncio.Event(), asyncio.Event()
        async def fail_once(route):
            attempts.append(route.request.post_data_json['submission_id'])
            request_started.set()
            await release_request.wait()
            if len(attempts) == 1:
                await route.fulfill(status=503,json={'error':'test_outage'})
            else:
                await route.continue_()
        await page.route('**/api/v1/widget/ake_offline?*',fail_once)
        pending_click = asyncio.create_task(submit.click())
        await asyncio.wait_for(request_started.wait(), 10)
        assert await submit.is_disabled(), 'sending not disabled'
        assert await submit.inner_text() == 'Sending…'
        release_request.set()
        await pending_click
        await layer.get_by_role('status').filter(has_text='could not be sent').wait_for()
        assert await layer.locator('[name=email]').input_value() == 'ui-offline@example.invalid'
        await page.screenshot(path=str(output/'customer-retry.png'))
        await submit.click()
        await layer.get_by_role('heading',name='Message received').wait_for(timeout=30000)
        assert len(attempts)==2 and attempts[0]==attempts[1], 'retry loses idempotency key'
        await english(page)
        await page.screenshot(path=str(output/'customer-success.png'))
        results['offline'] = {'chinese_browser_english_ui':True,'validation':True,'focus':True,'failure_preserves_inputs':True,'retry_reuses_key':True,'real_fixture_submission':True}
        print('PASS offline English validation, retry and real fixture submission',flush=True)

        online = await browser.new_context(viewport={'width':400,'height':720},locale='zh-CN')
        chat = await online.new_page()
        chat.on('pageerror',lambda error:errors.append(type(error).__name__))
        async def available(route):
            await route.fulfill(json={'online':True,'reception':'human'})
        # Availability is simulated; the native form, conversation and messages use the disposable DB.
        await chat.route('**/api/v1/widget/ake_availability?*', available)
        await chat.goto(widget_url,wait_until='domcontentloaded')
        await chat.get_by_role('button',name='Start Conversation',exact=False).wait_for(timeout=30000)
        await english(chat)
        await chat.screenshot(path=str(output/'customer-home.png'))
        await chat.get_by_role('button',name='Start Conversation',exact=False).click()
        await chat.locator('form.formkit-form').wait_for()
        await chat.locator('form.formkit-form').get_by_label('Work email',exact=True).fill('invalid')
        await chat.get_by_role('button',name='Start Conversation',exact=False).click()
        await chat.wait_for_timeout(300)
        await english(chat)
        assert await chat.locator('.formkit-message').count() > 0
        for width in [400,390,320]:
            await chat.set_viewport_size({'width':width,'height':740})
            assert not await chat.evaluate('document.documentElement.scrollWidth > innerWidth'), 'widget horizontal overflow'
            await chat.screenshot(path=str(output/f'customer-online-form-{width}.png'))
        await chat.locator('form.formkit-form').get_by_label('Work email',exact=True).fill('ui-online@example.invalid')
        await chat.locator('form.formkit-form textarea[name=message]').fill('Fictional UI acceptance: we are planning a new parking project.')
        await chat.get_by_role('button',name='Start Conversation',exact=False).click()
        await chat.locator('[id^=cwmsg-]').first.wait_for(timeout=30000)
        await chat.locator('.ake-receipt').filter(has_text='Delivered').wait_for(timeout=20000)
        await english(chat)
        await chat.screenshot(path=str(output/'customer-conversation.png'))
        token = await chat.evaluate('window.authToken')
        await chat.unroute('**/api/v1/widget/ake_availability?*',available)
        await chat.goto(base+'/widget?'+urlencode({'website_token':fixture['website_token'],'cw_conversation':token}),wait_until='domcontentloaded')
        await chat.get_by_role('button',name='Continue conversation',exact=False).click(timeout=30000)
        await chat.locator('[id^=cwmsg-]').first.wait_for(timeout=30000)
        await chat.wait_for_timeout(1200)
        assert not await chat.locator('#ake-offline-form').is_visible(), 'offline overlay hides returning conversation'
        assert not await chat.locator('#app').evaluate('(app)=>app.inert')
        await english(chat)
        results['online'] = {'availability_simulated':True,'form_english':True,'widths':[400,390,320],'real_fixture_conversation':True,'delivered_receipt':True,'offline_return':True}
        print('PASS online English form, delivery receipt and offline returning conversation',flush=True)

        host = await visitor.new_page()
        # Exercise the real SDK, including a parent page that explicitly requests Chinese.
        html='<!doctype html><html lang="zh-CN"><body><h1>Fictional widget host</h1><script>window.chatwootSettings={locale:"zh_CN",position:"right"};</script><script src="/packs/js/sdk.js"></script><script>window.chatwootSDK.run('+json.dumps({'websiteToken':fixture['website_token'],'baseUrl':base})+');</script></body></html>'
        await host.route('**/qa-widget-host',lambda route:route.fulfill(content_type='text/html',body=html))
        await host.goto(base+'/qa-widget-host')
        await host.wait_for_function('!!window.$chatwoot',timeout=30000)
        await host.evaluate('window.$chatwoot.toggle("open")')
        iframe = host.frame_locator('iframe#chatwoot_live_chat_widget')
        await iframe.locator('#ake-offline-form').wait_for(state='visible',timeout=30000)
        await host.evaluate('window.$chatwoot.setLocale("zh_CN")')
        await host.wait_for_timeout(300)
        assert not re.search(r'[\u3400-\u9fff]',await iframe.locator('body').inner_text())
        await iframe.locator('#ake-offline-form').get_by_role('button',name='Close chat').click()
        await host.wait_for_timeout(300)
        assert not await host.locator('.woot-widget-holder').is_visible()
        results['embedded_sdk'] = {'parent_zh_locale_ignored':True,'close':True}
        results['page_errors'] = errors
        assert not errors, 'browser runtime errors'
        (output/'ui-regression.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
        print(json.dumps(results,ensure_ascii=False),flush=True)
        await browser.close()


try:
    asyncio.run(main())
except Exception as error:
    # Browser errors may contain the visitor token in URLs. Keep raw diagnostics private.
    if os.environ.get('AKE_UI_PRIVATE_ERROR'):
        import traceback
        path=Path(os.environ['AKE_UI_PRIVATE_ERROR']);path.write_text(traceback.format_exc());path.chmod(0o600)
    print(json.dumps({'failed':type(error).__name__}),flush=True)
    raise SystemExit(1)
