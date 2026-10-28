# VPS relay

`relay.mjs` is the fixed HTTP/WebSocket bridge to the office reverse tunnel.
The office remains the only writer. The VPS does not run a second Inbox database,
store messages, retry POSTs or acknowledge messages while the office is offline.

Copy `relay.env.example` to a private runtime file and set the two exact public
Host headers, including a nonstandard port when used. Tunnel listeners `24720`
and `24721` must bind only on the VPS loopback. Keep the relay listener on loopback
behind the existing TLS proxy. Do not expose the tunnel or relay ports publicly.

Mount the reviewed `relay.mjs` read-only in a Node 24 container, use the host network
for the loopback tunnel, and run `node /relay/proxy.mjs`. Configure Docker's
`unless-stopped` restart policy so a VPS reboot restores the bridge. Preserve
existing TLS/website routing. Retain the previous image, environment file and
script before switching the relay mount to a new version directory.

Verification: compare the served native asset bytes with the new source, open the
public login and workspace paths, and confirm the old website still responds.
Do not test a production relay by sending customer messages.
