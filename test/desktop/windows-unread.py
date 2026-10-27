"""Real native read receipts and desktop alerts on an isolated synthetic seat.

Run with only the candidate QA client open. Lock events here are injected;
physical Windows lock-screen acceptance is recorded separately.
"""
import datetime, importlib.util, json, pathlib, sys, time, urllib.request

root = pathlib.Path(sys.argv[1])
conversation = int(sys.argv[2])
spec = importlib.util.spec_from_file_location('ui', pathlib.Path(__file__).with_name('windows-ui.py'))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
fixtures = json.loads((root / 'private/office-fixtures.json').read_text())
assert fixtures['nativeUrl'] == 'http://127.0.0.1:14750' and conversation > 0
client, node = ui.WindowsUI(14769), ui.WindowsUI(14770, node=True)
main = client.attach(next(t for t in client.targets() if t['url'].startswith('file:///')))
native = client.attach(next(t for t in client.targets() if t['url'].startswith('http://localhost:14750/')))
saved = client.evaluate(main, 'window.inboxDesktop.status()')['preferences']['notifications']
checks = {}
report = {'testedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'checks': checks, 'passed': False, 'physicalLock': False, 'systemNotificationsDisabled': False}

def summary():
    request = urllib.request.Request(fixtures['nativeUrl'] + '/api/v1/accounts/1/ake_reception/desktop',
                                     headers={'api_access_token': fixtures['users'][1]['token']})
    result = json.load(urllib.request.urlopen(request, timeout=10))
    return {'unreadCount': result['unreadCount'], 'conversations': result['conversations']}

def unread():
    return next((row['unreadCount'] for row in summary()['conversations'] if row['conversationId'] == conversation), 0)

def send():
    request = urllib.request.Request(fixtures['nativeUrl'] + '/api/v1/widget/messages?website_token=' + fixtures['websiteToken'],
        headers={'Content-Type': 'application/json', 'X-Auth-Token': fixtures['widgetToken']},
        data=json.dumps({'message': {'content': 'Synthetic desktop visibility acceptance message.', 'timestamp': time.time()}}).encode())
    return json.load(urllib.request.urlopen(request, timeout=15))['id']

try:
    assert client.evaluate(native, 'location.pathname') == f'/app/accounts/1/conversations/{conversation}'
    assert not unread(), 'Open and read the synthetic conversation before this test'
    client.evaluate(main, 'window.inboxDesktop.preferences({notifications:false})')
    node.evaluate(None, "(()=>{const e=process.mainModule.require('electron'),w=e.BrowserWindow.getAllWindows()[0];globalThis.qaUnread={flash:0,overlay:0};globalThis.qaUnreadOriginal={flash:w.flashFrame,overlay:w.setOverlayIcon};w.flashFrame=function(on){if(on)qaUnread.flash++;return qaUnreadOriginal.flash.call(this,on)};w.setOverlayIcon=function(icon,label){if(icon&&!icon.isEmpty())qaUnread.overlay++;return qaUnreadOriginal.overlay.call(this,icon,label)};return true})()")
    node.evaluate(None, "process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close();true")
    report['trayMessageId'] = send()
    ui.wait(lambda: unread() > 0, 15)
    ui.wait(lambda: node.evaluate(None, 'qaUnread.flash > 0 && qaUnread.overlay > 0'), 15)
    time.sleep(2)
    assert unread() > 0, 'The hidden page marked the new message read'
    checks['trayKeepsUnreadAndAlertsWithAppToastsDisabled'] = True
    native = client.attach(next(t for t in client.targets() if ':14750/' in t['url']))
    before = client.evaluate(native, 'performance.timeOrigin')
    node.evaluate(None, "(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];w.restore();w.show();w.focus();w.contentView.children[0].webContents.focus();return true})()")
    ui.wait(lambda: unread() == 0, 20)
    assert client.evaluate(native, 'performance.timeOrigin') == before
    checks['viewingCurrentConversationClearsUnreadWithoutReload'] = True

    client.evaluate(main, 'window.inboxDesktop.settings()')
    report['settingsMessageId'] = send()
    ui.wait(lambda: unread() > 0, 15)
    time.sleep(2)
    assert unread() > 0
    client.evaluate(main, "window.inboxDesktop.open('inbox')")
    ui.wait(lambda: unread() == 0, 20)
    checks['settingsPaneKeepsUnreadUntilInboxViewed'] = True

    node.evaluate(None, "process.mainModule.require('electron').powerMonitor.emit('lock-screen');true")
    report['lockedMessageId'] = send()
    ui.wait(lambda: unread() > 0, 15)
    time.sleep(2)
    assert unread() > 0
    assert client.evaluate(main, 'window.inboxDesktop.status()')['reception']['online']
    node.evaluate(None, "process.mainModule.require('electron').powerMonitor.emit('unlock-screen');true")
    ui.wait(lambda: unread() == 0, 20)
    checks['injectedLockKeepsOnlineAndUnreadUntilUnlock'] = True
    ui.wait(lambda: client.evaluate(main, 'window.inboxDesktop.status()')['reception']['unreadCount'] == summary()['unreadCount'], 20)
    checks['desktopCountMatchesServerAfterReading'] = True
    report['passed'] = True
finally:
    client.evaluate(main, 'window.inboxDesktop.preferences({notifications:' + json.dumps(saved) + '})')
    node.evaluate(None, "(()=>{const e=process.mainModule.require('electron'),w=e.BrowserWindow.getAllWindows()[0];e.powerMonitor.emit('unlock-screen');if(globalThis.qaUnreadOriginal){w.flashFrame=qaUnreadOriginal.flash;w.setOverlayIcon=qaUnreadOriginal.overlay;delete globalThis.qaUnreadOriginal;delete globalThis.qaUnread;}if(w.isMinimized())w.restore();w.show();w.focus();return true})()")
    (root / 'evidence/windows-unread.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    client.close()
    node.close()
