"""Exercise the Windows notification activation path against a synthetic QA seat.

This calls the registered COM activator; a human notification-center click is
recorded separately. It checks native view geometry as well as the loaded DOM.
"""
import base64, datetime, importlib.util, json, pathlib, subprocess, sys, time

root = pathlib.Path(sys.argv[1])
conversation = int(sys.argv[2])
label = sys.argv[3]
assert conversation > 0 and label.replace('-', '').isalnum()
spec = importlib.util.spec_from_file_location('ui', pathlib.Path(__file__).with_name('windows-ui.py'))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
client = ui.WindowsUI(14769)
node = ui.WindowsUI(14770, node=True)
checks = []
report = {'testedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': checks,
          'humanClick': False, 'passed': False}
activation = r'''
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;[ComImport,Guid("53E31837-6600-4A81-9395-75CFFE746F94"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface InboxActivate {void Activate([MarshalAs(UnmanagedType.LPWStr)] string appId,[MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,IntPtr data,uint count);} public class InboxCom {public static void Send(string clsid,string appId,string args){Type t=Type.GetTypeFromCLSID(new Guid(clsid));var o=Activator.CreateInstance(t);((InboxActivate)o).Activate(appId,args,IntPtr.Zero,0);Marshal.ReleaseComObject(o);}}'
$folder=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$sh=New-Object -ComObject Shell.Application
$link=$sh.NameSpace($folder).ParseName('AKE Inbox.lnk')
$appId=$link.ExtendedProperty('System.AppUserModel.ID')
if($appId -notlike 'com.ake.inbox.acceptance.*'){throw 'Refusing non-QA activation'}
[InboxCom]::Send($link.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID'),$appId,'ake-inbox:1:__CONVERSATION__')
'''.replace('__CONVERSATION__', str(conversation))
try:
    main = client.attach(next(t for t in client.targets() if t['url'].startswith('file:///')))
    native = client.attach(next(t for t in client.targets() if t['url'].startswith('http://localhost:14750/')))
    for cycle in range(3):
        before = client.evaluate(native, '({path:location.pathname,started:performance.timeOrigin})')
        # A hidden window is restored to a minimized taskbar button on a message.
        node.evaluate(None, "(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];w.hide();w.showInactive();w.minimize();return true})()")
        time.sleep(0.5)
        p = subprocess.run(['powershell.exe', '-NoProfile', '-EncodedCommand',
                            base64.b64encode(activation.encode('utf-16le')).decode()],
                           capture_output=True, timeout=20)
        assert p.returncode == 0, 'QA notification activation failed'
        ui.wait(lambda: client.evaluate(native, f"location.pathname==='/app/accounts/1/conversations/{conversation}'"))
        time.sleep(1.2)
        window = node.evaluate(None, "(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];return {visible:w.isVisible(),minimized:w.isMinimized(),size:w.getContentSize(),views:w.contentView.children.map(v=>v.getBounds())}})()")
        content = client.evaluate(native, "({hasMessages:!!document.querySelector('[data-message-id], .message-content, .message-text__wrap'),bodyChars:document.body.innerText.length,started:performance.timeOrigin})")
        checks.append({'cycle': cycle + 1, 'window': window, 'content': content})
        assert window['visible'] and not window['minimized'], 'Window did not restore'
        assert len(window['views']) == 1, 'Inbox view was not attached'
        bounds = window['views'][0]
        assert bounds['width'] == window['size'][0] and bounds['height'] == window['size'][1] - 72, 'Native inbox view is empty or incorrectly sized'
        assert content['hasMessages'] and content['bodyChars'] > 100, 'Conversation content was not rendered'
        if before['path'] == f'/app/accounts/1/conversations/{conversation}':
            assert content['started'] == before['started'], 'Opening the current conversation unnecessarily reloads the whole page'
        assert client.evaluate(main, 'window.inboxDesktop.status()')['reception']['online']
    report['passed'] = True
finally:
    (root / 'evidence' / f'notification-viewport-{label}.json').write_text(json.dumps(report, indent=2))
    client.close()
    node.close()
    print(json.dumps(report), flush=True)
