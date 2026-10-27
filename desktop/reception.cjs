const { randomUUID } = require('node:crypto');

class Reception {
  constructor({ request, socket, notify, changed, now = Date.now }) {
    Object.assign(this, { request, socket, notify, changed, now });
    this.clientId = randomUUID(); this.context = null; this.online = false;
    this.paused = false; this.suspended = false; this.busy = false; this.generation = 0;
    this.unreadCount = 0; this.seen = new Map(); this.baselined = false;
    this.lastSnapshot = 0; this.ws = null; this.reconnected = false; this.initial = true;
    this.leaseQueue = Promise.resolve();
  }
  state() { return { online: this.online, paused: this.paused, unreadCount: this.unreadCount, authenticated: !!this.context, suspended: this.suspended }; }
  heartbeat(context, body, timeout) {
    const call = this.leaseQueue.then(() => this.request(context, 'heartbeat', body, timeout));
    this.leaseQueue = call.catch(() => {}); return call;
  }
  async connect(context) {
    if (this.context?.identity === context.identity) return;
    await this.disconnect(); this.context = context; this.initial = true; this.paused = false;
    await this.tick();
  }
  closeSocket() {
    clearTimeout(this.refreshTimer); this.refreshTimer = null;
    const ws = this.ws; this.ws = null; if (ws) ws.close();
  }
  async disconnect() {
    const old = this.context; this.context = null; this.generation++;
    this.closeSocket(); this.online = false; this.unreadCount = 0;
    this.seen.clear(); this.baselined = false; this.lastSnapshot = 0;
    if (old) { try { await this.heartbeat(old, { clientId: this.clientId, state: 'offline' }, 1800); } catch {} }
    this.changed(this.state());
  }
  async setOnline(value) {
    this.paused = !value; this.initial = value;
    if (this.context && !value) {
      this.online = false; this.changed(this.state());
      try { await this.heartbeat(this.context, { clientId: this.clientId, state: 'offline' }, 3000); } catch {}
    } else await this.tick();
    return this.state();
  }
  async suspend(value) {
    this.suspended = value;
    if (value) { this.closeSocket(); this.online = false; this.changed(this.state());
      if (this.context) { try { await this.heartbeat(this.context, { clientId: this.clientId, state: 'offline' }, 1500); } catch {} }
    } else { this.initial = !this.paused; await this.tick(); }
  }
  async tick() {
    if (!this.context || this.busy || this.suspended) return;
    this.busy = true; const context = this.context, generation = this.generation;
    try {
      // Probe capability before changing availability on an older server.
      if (!this.baselined) await this.snapshot(context, generation);
      if (generation !== this.generation || this.suspended) return;
      if (!this.paused) {
        const result = await this.heartbeat(context, { clientId: this.clientId, ...(this.initial ? { state: 'online' } : {}) });
        if (generation !== this.generation) return;
        if (result.protocolVersion !== 2) throw Object.assign(new Error('server_upgrade_required'), { status: 426 });
        this.online = !this.paused && !this.suspended && result.instanceOnline === true; this.initial = false;
      }
      if (!this.ws || this.now() - this.lastSnapshot >= 60000) await this.snapshot(context, generation);
      if (generation === this.generation) this.changed({ ...this.state(), connection: 'connected' });
    } catch (error) {
      if (generation !== this.generation) return;
      this.online = false; this.closeSocket(); this.reconnected = this.baselined;
      if (error.status === 401) { this.context = null; this.seen.clear(); this.baselined = false; this.unreadCount = 0; }
      this.changed({ ...this.state(), connection: error.status === 401 ? 'signed_out' : error.status === 403 ? 'forbidden' : [404,426].includes(error.status) ? 'incompatible' : 'failed' });
    } finally { this.busy = false; }
  }
  async snapshot(context = this.context, generation = this.generation) {
    if (!context) return;
    const data = await this.request(context, 'desktop');
    if (generation !== this.generation || context !== this.context) return;
    if (data.protocolVersion !== 2 || data.accountId !== context.accountId || !Number.isSafeInteger(data.userId)) throw Object.assign(new Error('server_upgrade_required'), { status: 426 });
    const rows = Array.isArray(data.conversations) ? data.conversations.slice(0, 100) : [];
    const fresh = [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.conversationId) || row.conversationId < 1 || !Number.isSafeInteger(row.lastMessageId)) continue;
      if (this.baselined && row.lastMessageId > (this.seen.get(row.conversationId) || 0)) fresh.push(row);
      this.seen.delete(row.conversationId); this.seen.set(row.conversationId, row.lastMessageId);
    }
    while (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value);
    this.unreadCount = Number.isSafeInteger(data.unreadCount) && data.unreadCount >= 0 ? data.unreadCount : 0;
    if (fresh.length) this.notify({ accountId: data.accountId, conversationId: fresh[0].conversationId, count: fresh.length, recovered: this.reconnected });
    this.baselined = true; this.reconnected = false; this.lastSnapshot = this.now();
    this.changed(this.state());
    if (!this.suspended && !this.ws && typeof data.pubsubToken === 'string' && data.pubsubToken.length < 512) this.openSocket(context, data, generation);
  }
  openSocket(context, data, generation) {
    const url = new URL('/cable', context.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.socket(url.href, context.origin); this.ws = ws;
    const identifier = JSON.stringify({ channel: 'RoomChannel', pubsub_token: data.pubsubToken, user_id: data.userId, account_id: data.accountId });
    ws.on('open', () => { if (ws === this.ws) ws.send(JSON.stringify({ command: 'subscribe', identifier })); });
    ws.on('message', raw => {
      if (ws !== this.ws || generation !== this.generation || raw.length > 131072) return;
      let event; try { event = JSON.parse(String(raw)); } catch { return; }
      if (event.type === 'reject_subscription') { ws.close(); return; }
      const name = event.message?.event;
      if (typeof name !== 'string' || !/^(message\.|notification\.|conversation\.|assignee\.)/.test(name)) return;
      if (!this.refreshTimer) this.refreshTimer = setTimeout(async () => {
        this.refreshTimer = null;
        try { await this.snapshot(context, generation); } catch { this.lastSnapshot = 0; }
      }, 500);
    });
    ws.on('error', () => ws.close());
    ws.on('close', () => { if (ws === this.ws) { this.ws = null; this.reconnected = this.baselined; } });
  }
}
module.exports = { Reception };
