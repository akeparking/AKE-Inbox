const path = require('node:path');
const { packager } = require('@electron/packager');
packager({
  dir: __dirname, name: 'AKE-Inbox', platform: 'win32', arch: 'x64',
  out: process.env.AKE_PACKAGE_OUTPUT || path.join(__dirname, 'out'),
  overwrite: true, asar: true, prune: true, executableName: 'AKE-Inbox',
  icon: path.join(__dirname, 'ui', 'app.ico'),
  ignore: [/^\/test(?:\/|$)/, /^\/out(?:\/|$)/, /^\/evidence(?:\/|$)/, /^\/package-lock\.json$/, /^\/package\.cjs$/],
  win32metadata: { CompanyName: 'AKE', FileDescription: 'AKE Inbox Workbench', ProductName: 'AKE Inbox' }
}).then(paths => console.log(paths.join('\n'))).catch(() => { console.error('Windows packaging failed'); process.exitCode = 1; });
