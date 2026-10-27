import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const [tag, windowsDirectory, outputDirectory, evidenceFile] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || !windowsDirectory || !outputDirectory) throw new Error('Usage: node scripts/build-desktop-release.mjs vX.Y.Z WindowsDirectory OutputDirectory [EvidenceJSON]');
const pkg = JSON.parse(await readFile('desktop/package.json', 'utf8'));
if (`v${pkg.version}` !== tag) throw new Error('Desktop package and release version differ');
const windows = resolve(windowsDirectory), output = resolve(outputDirectory);
if (!(await stat(join(windows, 'AKE-Inbox.exe'))).isFile()) throw new Error('Windows executable is missing');
await mkdir(output, { recursive: true });
const evidence = evidenceFile ? JSON.parse(await readFile(evidenceFile, 'utf8')) : { status: `${tag} 候选版 · 实机验收待完成` };
const template = await readFile('docs/desktop/index.template.html', 'utf8');
const safe = JSON.stringify(evidence).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const html = template.replace('/*__AKE_RELEASE_DATA__*/{}', safe);
if (html === template) throw new Error('HTML release data placeholder not found');
await writeFile(join(output, 'index.html'), html);
await copyFile(join(output, 'index.html'), join(windows, 'index.html'));
const compatibility = { version: pkg.version, platform: 'win32', arch: 'x64', signed: false, receptionProtocol: 2,
  minimumReceptionBackend: '0.2.1', legacyClientsSupportedByBackend: true, databaseMigrationRequired: false,
  userDataDirectory: '%APPDATA%/AKE Inbox', heartbeatSeconds: 20, leaseSeconds: 75,
  updateMethod: 'manual-zip', updateRepository: 'akeparking/AKE-Inbox', minimumWindows: 'Windows 10 x64',
  keyLocation: 'office-host-only', channelBindingsReset: false };
await writeFile(join(output, 'client-compatibility.json'), JSON.stringify(compatibility, null, 2) + '\n');
await copyFile(join(output, 'client-compatibility.json'), join(windows, 'client-compatibility.json'));
const sourcePrefix = `AKE-Inbox-${tag}/`;
execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { stdio: 'pipe' });
for (const format of ['zip', 'tar.gz']) execFileSync('git', ['archive', `--format=${format}`, `--prefix=${sourcePrefix}`, '-o', join(output, `AKE-Inbox-${tag}-source.${format}`), `refs/tags/${tag}`]);
const zipName = `AKE-Inbox-${tag}-windows-x64.zip`;
execFileSync('python3', ['-c', `import pathlib,sys,zipfile
source=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2]);prefix=sys.argv[3]
with zipfile.ZipFile(target,'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f in sorted(source.rglob('*')):
  if f.is_file():z.write(f,prefix+'/'+f.relative_to(source).as_posix())
`, windows, join(output, zipName), `AKE-Inbox-${tag}`]);
const names = [zipName, `AKE-Inbox-${tag}-source.zip`, `AKE-Inbox-${tag}-source.tar.gz`, 'index.html', 'client-compatibility.json'].sort();
const sums=[];
for (const name of names) { const hash = createHash('sha256'); for await (const chunk of createReadStream(join(output,name))) hash.update(chunk); sums.push(`${hash.digest('hex')}  ${name}`); }
await writeFile(join(output,'SHA256SUMS.txt'), sums.join('\n')+'\n');
console.log(JSON.stringify({tag, files:[...names,'SHA256SUMS.txt'], commit:execFileSync('git',['rev-parse',`refs/tags/${tag}^{commit}`],{encoding:'utf8'}).trim()}));
