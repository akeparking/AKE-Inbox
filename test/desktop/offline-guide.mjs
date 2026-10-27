import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const [html, endpoint, output] = process.argv.slice(2);
if (!html || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(endpoint || '') || !output) throw new Error('Usage: offline-guide.mjs HtmlFile LocalChromeDebugEndpoint EvidenceDirectory');
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let id = 0; const pending = new Map(); const exceptions = [];
ws.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.text);
  if (pending.has(data.id)) { const done = pending.get(data.id); pending.delete(data.id); done(data); }
});
async function call(method, params = {}) {
  const n = ++id;
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(n, data => { clearTimeout(timeout); resolve(data); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  if (result.error) throw new Error(result.error.message);
  return result.result;
}
async function js(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(r.exceptionDetails, undefined); return r.result.value;
}
await mkdir(output, { recursive: true });
try {
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: pathToFileURL(resolve(html)).href });
  for (let n = 0; n < 40 && !(await js("!!document.getElementById('demo-message')")); n++) await new Promise(r => setTimeout(r, 100));
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await js("document.querySelectorAll('script[src],link[rel=stylesheet],iframe').length"), 0);
  assert.equal(await js("Array.from(document.querySelectorAll('a[href^=\"#\"]')).every(a=>document.getElementById(a.hash.slice(1)))"), true);
  await writeFile(join(output, 'guide-desktop.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  assert.equal(await js("document.getElementById('demo-message').click(); document.getElementById('demo-count').textContent"), '1');
  assert.equal(await js("document.getElementById('demo-read').click(); document.getElementById('demo-count').hidden"), true);
  for (const mode of ['tray', 'ai', 'off', 'online']) {
    assert.equal(await js(`document.querySelector('[data-mode="${mode}"]').click();document.querySelector('[data-mode="${mode}"]').getAttribute('aria-pressed')`), 'true');
  }
  await js("document.getElementById('notifications').scrollIntoView({behavior:'instant'});document.getElementById('demo-message').click()");
  await writeFile(join(output, 'guide-notifications.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await js('scrollTo({top:0,behavior:"instant"})');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
  await writeFile(join(output, 'guide-mobile.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64'));
  assert.deepEqual(exceptions, []);
  const receipt = { offlineNetwork: true, externalDependencies: 0, desktopAndMobileNoOverflow: true, anchorsValid: true, simulatedStatesAndUnread: true, browserExceptions: exceptions };
  await writeFile(join(output, 'guide-validation.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { ws.close(); }
