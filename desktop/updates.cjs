const REPOSITORY = 'akeparking/AKE-Inbox';
function version(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
}
function newer(a, b) { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; }
function selectRelease(releases, current) {
  const base = version(current); if (!base || !Array.isArray(releases)) return null;
  return releases.filter(r => !r.draft && !r.prerelease && version(r.tag_name) && newer(version(r.tag_name), base))
    .sort((a, b) => newer(version(a.tag_name), version(b.tag_name)) ? -1 : 1)
    .map(r => {
      const asset = r.assets?.find(a => a.name === `AKE-Inbox-${r.tag_name}-windows-x64.zip` && a.state === 'uploaded');
      const checksum = r.assets?.find(a => a.name === 'SHA256SUMS.txt' && a.state === 'uploaded');
      const prefix = `https://github.com/${REPOSITORY}/releases/download/${r.tag_name}/`;
      if (!asset?.browser_download_url?.startsWith(prefix) || !checksum?.browser_download_url?.startsWith(prefix)) return null;
      return { version: r.tag_name, url: `https://github.com/${REPOSITORY}/releases/tag/${r.tag_name}`, downloadUrl: asset.browser_download_url };
    }).find(Boolean) || null;
}
module.exports = { REPOSITORY, selectRelease };
