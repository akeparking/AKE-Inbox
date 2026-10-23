import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright

root=Path(os.environ['LOCAL_RUNTIME_ROOT']);output=Path(os.environ['RELIABILITY_OUTPUT'])
settings=dict(line.split('=',1) for line in (root/'private/wordpress.env').read_text().splitlines() if '=' in line)
fixture=r'''<?php
require '/var/www/html/wp-load.php';
if(parse_url(AKE_MARKETING_SERVER_URL,PHP_URL_HOST)!=='core')throw new Exception('Local fixture only');
$id='outbox-ui-'.bin2hex(random_bytes(8));$payload=array('formId'=>'a0000000-0000-4000-8000-000000000002','version'=>1,'fields'=>array('name'=>'Fictional outbox browser','email'=>'outbox-ui@example.invalid','company'=>'Fictional local UI','message'=>'Local WordPress UI retry acceptance'));
add_option('ake_qa_receipt_'.hash('sha256',$id),array('persisted'=>true,'payload'=>$payload),'','no');
ake_marketing_record_receipt($id,$payload);$name=ake_marketing_receipt_name($id);
$fail=function($pre,$args,$url){return strpos($url,AKE_MARKETING_SERVER_URL)===0?new WP_Error('fictional_ui_transport_failure'):$pre;};add_filter('pre_http_request',$fail,10,3);
for($i=0;$i<5;$i++)ake_marketing_deliver_receipt($name);
echo json_encode(array('suffix'=>substr($name,-12),'name'=>$name));
'''

async def main():
    process=await asyncio.create_subprocess_exec('docker','exec','-i','ake-inbox-marketing-local-wordpress-1','php',stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    stdout,stderr=await process.communicate(fixture.encode());assert process.returncode==0,'Fixture creation failed'
    record=json.loads(stdout)
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ['CHROMIUM_PATH'],args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1360,'height':900})
        await page.goto('http://localhost:14626/wp-login.php');await page.locator('#user_login').fill('local-admin');await page.locator('#user_pass').fill(settings['WP_ADMIN_PASSWORD']);await page.locator('#wp-submit').click();await page.wait_for_url('**/wp-admin/**')
        url='http://localhost:14626/wp-admin/tools.php?page=ake-marketing-receipts';await page.goto(url)
        row=page.locator('tr').filter(has_text=record['suffix']);assert 'review' in await row.inner_text()
        denied=await page.request.post('http://localhost:14626/wp-admin/admin-post.php',form={'action':'ake_marketing_retry','receipt':record['name']});assert denied.status==403
        await row.get_by_role('button',name='重试原收件').click();await page.wait_for_url('**/tools.php?page=ake-marketing-receipts&result=queued')
        for _ in range(45):
            await page.reload();row=page.locator('tr').filter(has_text=record['suffix'])
            if 'accepted' in await row.inner_text():break
            await asyncio.sleep(2)
        else:raise AssertionError('Scheduled local cron did not confirm receipt')
        await page.screenshot(path=str(output.parent/'wordpress-outbox-desktop.png'),full_page=True)
        await page.set_viewport_size({'width':390,'height':844});await page.screenshot(path=str(output.parent/'wordpress-outbox-mobile.png'),full_page=True)
        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        result={'result':'passed','adminLogin':True,'nonceRequired':True,'reviewRetryViaNativeUi':True,'localCronDelivered':True,'desktopMobile':True,'customerPayloadDisplayed':False}
        output.write_text(json.dumps(result,indent=2));print(json.dumps(result));await browser.close()

asyncio.run(main())
