# Office relay

The office makes the SSH connection out to the VPS. Two loopback-only remote
ports forward native Inbox (24720) and the workspace (24721). The fixed proxy
exposes them only to the existing TLS proxy on the VPS bridge network.

The SSH account permits only these remote forwards, without shell, password,
agent forwarding or local port forwarding. Supervise the tunnel with systemd,
`ExitOnForwardFailure=yes`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`,
and `Restart=always`.

A relay never acknowledges messages that the office has not accepted. During a
complete office or tunnel outage it returns 503; visitors must keep and retry
unsent text. Already accepted messages and jobs remain durable on the office
host. Email stays at the mail provider until the local inbox reconnects.
A relay by itself cannot provide AI while the office host is powered off.

Cutover requires a final authoritative database and attachment snapshot, Windows
acceptance, a verified model API response, a replay/duplicate check, and an HTTP and
WebSocket check through the staged tunnel. Preserve the previous release and
backups. Stop only the old Inbox workers and applications; the legacy website,
its database and the TLS proxy remain running.
