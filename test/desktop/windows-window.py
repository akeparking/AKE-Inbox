"""Operate the test application's Windows UI, scoped to its exact EXE path."""
import base64,json,subprocess,sys
exe=sys.argv[1];action=sys.argv[2];assert action in ['close','show','inspect','quit']
ps="""[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class InboxWin { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }'
$items=@(Get-Process -Name AKE-Inbox -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq '%s'})
foreach ($p in $items) { if ($p.MainWindowHandle -ne 0) { %s } }
@{processes=$items.Count;visibleHandles=@($items | Where-Object {$_.MainWindowHandle -ne 0}).Count;action='%s'} | ConvertTo-Json -Compress
"""%(exe.replace("'","''"),{'close':'[void][InboxWin]::PostMessage($p.MainWindowHandle,16,[IntPtr]::Zero,[IntPtr]::Zero)','show':'[void][InboxWin]::ShowWindow($p.MainWindowHandle,9)','inspect':'','quit':'[void][InboxWin]::PostMessage($p.MainWindowHandle,274,[IntPtr]61536,[IntPtr]::Zero)'}[action],action)
r=subprocess.run(['powershell.exe','-NoProfile','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,text=True,encoding='utf-8',errors='replace',check=True,timeout=30);print(r.stdout.strip())
