"""Browser acceptance against disposable fictional Chatwoot fixtures only."""
import asyncio
import json
import os
from pathlib import Path
import sys
from playwright.async_api import async_playwright


async def main():
    fixture = json.loads(Path(os.environ['AKE_WIDGET_FIXTURE']).read_text())
    base = os.environ.get('AKE_WIDGET_TEST_URL', 'http://127.0.0.1:14619')
    assert '127.0.0.1' in base or 'localhost' in base, 'isolated local browser fixture required'
    output = Path(os.environ['AKE_WIDGET_TEST_OUTPUT'])
    output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox', '--no-proxy-server']}
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**options)
        visitor = await browser.new_context(viewport={'width': 440, 'height': 900}, locale='en-US', timezone_id='Asia/Shanghai')
        page = await visitor.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        await page.goto(base + '/widget?website_token=' + fixture['website_token'] + '&cw_conversation=' + fixture['auth_token'], wait_until='domcontentloaded')
        await page.get_by_text('Continue conversation', exact=False).click(timeout=30000)
        await page.locator('#cwmsg-' + str(fixture['human_id']) + ' .ake-message-meta').wait_for(timeout=30000)
        assert not await page.locator('#ake-offline-form').is_visible(), 'offline overlay obscures an existing conversation'
        assert 'Fixture Agent' in await page.locator('#cwmsg-' + str(fixture['human_id']) + ' .ake-message-meta').inner_text(), 'human name missing'
        assert 'AI Agent' in await page.locator('#cwmsg-' + str(fixture['ai_id']) + ' .ake-message-meta').inner_text(), 'AI identity missing'
        assert await page.locator('#cwmsg-' + str(fixture['human_id']) + ' time').get_attribute('datetime'), 'absolute timestamp missing'
        assert await page.locator('.ake-continuity-note').is_visible(), 'email continuity hint missing'
        print(json.dumps({'sender_labels': 'passed', 'timestamps': 'passed', 'offline_resume': 'passed'}), flush=True)

        editor = page.locator('textarea:visible').last
        await editor.fill('A new fictional customer question for the receipt test.')
        await editor.press('Enter')
        own = page.locator('.user-message-wrap[id^="cwmsg-"]').last
        await own.locator('.ake-receipt').filter(has_text='Delivered').wait_for(timeout=15000)
        incoming_id = await own.get_attribute('id')
        print(json.dumps({'persisted_message_receipt': 'Delivered'}), flush=True)

        operator = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        desk = await operator.new_page()
        await desk.goto(base + '/app/login', wait_until='domcontentloaded')
        await desk.locator('input[name=email_address]').fill(fixture['email'])
        await desk.locator('input[type=password]').fill(fixture['password'])
        await desk.locator('button[type=submit]').click()
        await desk.wait_for_url('**/app/accounts/**', timeout=30000)
        await desk.goto(base + '/app/accounts/1/inbox/all/conversations/' + str(fixture['conversation_id']), wait_until='domcontentloaded')
        await page.locator('#' + incoming_id + ' .ake-receipt').filter(has_text='Read').wait_for(timeout=20000)
        print(json.dumps({'human_view_receipt': 'Read'}), flush=True)

        await page.set_viewport_size({'width': 390, 'height': 844})
        await own.scroll_into_view_if_needed()
        receipt_box = await own.locator('.ake-receipt').bounding_box()
        editor_box = await editor.bounding_box()
        assert receipt_box['y'] + receipt_box['height'] < editor_box['y'], 'latest receipt hidden by the composer'
        await page.screenshot(path=str(output / 'widget-mobile.png'))
        assert not await page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'horizontal overflow on mobile'
        assert not errors, 'browser runtime errors'
        await page.set_viewport_size({'width': 560, 'height': 1000})
        await page.screenshot(path=str(output / 'widget-desktop.png'))

        async def reject_send(route):
            if route.request.method == 'POST':
                await route.abort('failed')
            else:
                await route.continue_()
        await page.route('**/api/v1/widget/messages?*', reject_send)
        await editor.fill('Fictional failed send test.')
        await editor.press('Enter')
        await page.locator('.ake-receipt').filter(has_text='Not sent').wait_for(timeout=15000)
        print(json.dumps({'failed_send_does_not_claim_delivery': 'passed', 'mobile_layout': 'passed', 'browser_errors': len(errors)}), flush=True)
        await browser.close()


try:
    asyncio.run(main())
except Exception as error:
    # Playwright navigation errors can include the visitor JWT in their URL.
    # Keep private diagnostics off stdout and never echo fixture credentials.
    private_log = os.environ.get('AKE_WIDGET_PRIVATE_ERROR')
    if private_log:
        Path(private_log).write_text(str(error))
        Path(private_log).chmod(0o600)
    print(json.dumps({'browser_test_failed': type(error).__name__}))
    sys.exit(1)
