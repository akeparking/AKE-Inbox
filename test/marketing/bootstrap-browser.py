import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright

root=Path(os.environ['LOCAL_REBUILD_ROOT'])
install=json.loads((root/'private/local-install.json').read_text())
assert install['status']=='ready' and install['project'].startswith('ake-mkt-rebuild-')
base=install['basePort'];assert base!=14620
accounts=json.loads((root/'private/accounts.json').read_text());user=accounts['users']['admin'];aid=accounts['accountId']
inbox=f'http://localhost:{base}';site=f'http://localhost:{base+1}'

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ['CHROMIUM_PATH'],args=['--no-sandbox'])
        customer=await browser.new_page();errors=[];customer.on('pageerror',lambda error:errors.append(str(error)))
        async def query(action,body):
            response=await customer.request.post(inbox+f'/api/v1/accounts/{aid}/ake_marketing/'+action,
                headers={'api_access_token':user['token']},data={'input':body})
            assert response.ok,action
            return await response.json()
        await customer.goto(site+'/?utm_source=local-rebuild&utm_medium=acceptance')
        await customer.get_by_role('button',name='允许分析',exact=True).click()
        await customer.wait_for_function('!!AKEMarketing.getState().visitorId')
        visitor=await customer.evaluate('AKEMarketing.getState().visitorId')
        for url in ['/products/guidance','/products/payment']:
            await customer.goto(site+url)
            await customer.wait_for_function('!!AKEMarketing.getState().visitorId')
            await customer.evaluate('AKEMarketing.flush()')
            assert await customer.evaluate('AKEMarketing.getState().visitorId')==visitor
        payloads=[]
        customer.on('request',lambda request:payloads.append(request.post_data_json) if request.url.endswith('/public/submissions') else None)
        for field,value in {'name':'Fictional rebuild visitor','email':'rebuild@example.invalid','company':'Fictional rebuild company','message':'Local fresh installation acceptance only'}.items():
            await customer.locator(f'[name={field}]').fill(value)
        await customer.get_by_role('button',name='Send inquiry',exact=True).click()
        await customer.get_by_role('status').filter(has_text='Your inquiry has been received').wait_for()
        inquiry=None
        for _ in range(60):
            found=[x for x in (await query('inquiries',{}))['inquiries'] if x['visitor_id']==visitor]
            if found and found[0]['conversation_id']:inquiry=found[0];break
            await asyncio.sleep(.5)
        assert inquiry,'Native conversation did not receive persisted inquiry'
        timeline=await query('visitor',{'id':visitor});views=[x for x in timeline['events'] if x['event_type']=='page_view']
        assert len(views)==3
        assert [x['data']['pageUrl'].split(str(base+1))[-1].split('?')[0] for x in views]==['/','/products/guidance','/products/payment']
        assert timeline['visitor']['firstTouch']['utm']['utm_source']=='local-rebuild'
        agent=await browser.new_page(viewport={'width':1440,'height':1000})
        await agent.goto(inbox+'/app/login');await agent.locator('input[name=email_address]').fill(user['email']);await agent.locator('input[type=password]').fill(user['password']);await agent.get_by_role('button',name='Login',exact=True).click()
        await agent.wait_for_url('**/app/accounts/**',timeout=60000)
        await agent.goto(inbox+f'/ake/marketing?account={aid}');await agent.locator('#tabs button').first.wait_for()
        await agent.screenshot(path=str(root/'qa/bootstrap-desktop.png'),full_page=True)
        await agent.set_viewport_size({'width':390,'height':844});await agent.screenshot(path=str(root/'qa/bootstrap-mobile.png'),full_page=True)
        assert await agent.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        # Full fresh-stack stop/start, preserving its own volumes and credentials.
        log=(root/'private/restart-test.log').open('w')
        env={**os.environ,'LOCAL_RUNTIME_ROOT':str(root)}
        for action in ['stop','start']:
            process=await asyncio.create_subprocess_exec('bash','deploy/marketing/local.sh',action,env=env,stdout=log,stderr=log)
            assert await process.wait()==0,action
        log.close()
        for _ in range(90):
            try:
                response=await customer.request.get(inbox+'/app/login',timeout=3000)
                if response.ok:break
            except Exception:pass
            await asyncio.sleep(2)
        else:raise AssertionError('Fresh stack did not restart')
        response=await customer.request.post(f'http://localhost:{base+2}/api/v1/inbox-v2/marketing/public/submissions',headers={'Origin':site},data=payloads[0])
        assert response.ok
        replay=await response.json();assert replay['inquiryId']==inquiry['id'] and replay['duplicate']
        after=await query('visitor',{'id':visitor});assert len([e for e in after['events'] if e['event_type']=='page_view'])==3
        found=[x for x in (await query('inquiries',{}))['inquiries'] if x['visitor_id']==visitor];assert len(found)==1
        assert not errors,errors
        result={'result':'passed','boundary':'empty local PostgreSQL, Redis, Chatwoot and storage volumes; existing compiled dependencies; no real providers',
          'pagesInOrder':3,'inquiries':1,'nativeConversationPersisted':True,'freshAdminBrowserLogin':True,'desktopMobile':True,'fullStackStopStart':True,'replayedSubmissionDuplicated':False,'errors':errors}
        (root/'qa/bootstrap-browser.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
        await browser.close()

asyncio.run(main())
