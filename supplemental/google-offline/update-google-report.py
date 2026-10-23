"""Render a private acceptance report from receipts, without copying customer evidence."""
import datetime as dt
import html
import json
import os
from pathlib import Path

root = Path(os.environ['GOOGLE_ACCEPTANCE_ROOT'])
output = Path(os.environ['GOOGLE_REPORT_ROOT'])
output.mkdir(parents=True, exist_ok=True, mode=0o700)

def read(name, default):
    path = root / name
    return json.loads(path.read_text()) if path.exists() else default

job = read('evidence/google-job-status.json', {})
case = read('private/google-case.json', {})
processing = read('evidence/google-processing.json', {})
upload = read('evidence/google-upload.json', {})
stages = processing.get('receiptStages') or upload.get('delivery', {}).get('receiptStages', {})
report = {
    'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
    'phase': job.get('phase', 'not_started'),
    'validation': 'passed' if read('evidence/google-validation.json', {}) else 'unconfirmed',
    'acceptance': 'accepted' if case.get('requestId') else 'unconfirmed',
    'processing': stages.get('processing', 'unknown'),
    'matching': 'unknown',
    'uploadAttempts': case.get('realPostCount', 0),
    'scope': 'Private, single-event acceptance. No customer identifiers exported.',
}
rows = '\n'.join(f'| {k} | {v} |' for k, v in report.items())
table = ''.join(f'<tr><th>{html.escape(k)}</th><td>{html.escape(str(v))}</td></tr>' for k, v in report.items())
files = {
    'google-acceptance.json': json.dumps(report, indent=2) + '\n',
    'google-acceptance.md': '# Google offline acceptance\n\n| Field | Result |\n|---|---|\n' + rows + '\n\nAccepted or processed does not establish advertising matching.\n',
    'google-acceptance.html': '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Google acceptance</title><h1>Google offline acceptance</h1><table>' + table + '</table><p>Accepted or processed does not establish advertising matching.</p></html>',
}
for name, content in files.items():
    path = output / name
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        stream.write(content)
print(json.dumps({'reportWritten': True, 'files': list(files), 'credentialsExported': False}))
