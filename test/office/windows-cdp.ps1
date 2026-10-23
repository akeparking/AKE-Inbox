# UI transport only. The acceptance tests and assertions run in WSL.
param([int]$Port = 14739)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 10
$socket = New-Object System.Net.WebSockets.ClientWebSocket
[void]$socket.ConnectAsync([Uri]$version.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
[Console]::WriteLine('{"ready":true,"transport":"Windows loopback CDP"}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $line | ConvertFrom-Json
  $bytes = [Text.Encoding]::UTF8.GetBytes($line)
  $segment = New-Object 'ArraySegment[byte]' -ArgumentList (,$bytes)
  [void]$socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  do {
    $stream = New-Object IO.MemoryStream
    do {
      $buffer = New-Object byte[] 65536
      $part = New-Object 'ArraySegment[byte]' -ArgumentList (,$buffer)
      $received = $socket.ReceiveAsync($part,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
      if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { exit 2 }
      $stream.Write($buffer,0,$received.Count)
    } while (!$received.EndOfMessage)
    $reply = [Text.Encoding]::UTF8.GetString($stream.ToArray())
    $message = $reply | ConvertFrom-Json
  } while ($message.id -ne $request.id)
  [Console]::WriteLine($reply)
}
$socket.Dispose()
