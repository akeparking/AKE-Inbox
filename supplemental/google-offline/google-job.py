"""Bounded, single-event Google acceptance; retries validation/status, never an upload."""
import datetime as dt
import fcntl
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get('GOOGLE_ACCEPTANCE_ROOT', '.'))
SCRIPTS = Path(__file__).resolve().parent
NODE = os.environ.get('NODE_BINARY', 'node')
TIMER = os.environ.get('GOOGLE_ACCEPTANCE_TIMER', 'ake-google-acceptance.timer')
TERMINAL = {'processed', 'processing_failed', 'validation_failed', 'authorization_failed',
            'requires_reconciliation', 'expired', 'guard_failed', 'upload_rejected', 'replay_failed'}

def read(path):
    return json.loads(path.read_text())

def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def next_step(case, now, target, deadline):
    if now > deadline:
        return 'expired'
    if case.get('requestId'):
        return 'status'
    if case.get('realPostCount', 0):
        return 'requires_reconciliation'
    if now < dt.datetime.fromisoformat(target['uploadNotBefore']):
        return 'waiting_for_target'
    return 'validate_then_upload_once'

def guard(root):
    manifest = read(root / 'private/execution-manifest.json')
    for item in manifest['files']:
        if hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() != item['sha256']:
            raise RuntimeError('Approved execution input changed')
    target = read(root / 'evidence/google-conversion-target.json')
    case = read(root / 'private/google-case.json')
    if case.get('eventId') != manifest['eventId'] or case.get('deliveryId') != manifest['deliveryId']:
        raise RuntimeError('Unexpected business event')
    expected = manifest.get('target', {})
    if (not expected.get('accountId') or not expected.get('actionId') or
            target['accountId'] != expected['accountId'] or target['actionId'] != expected['actionId']):
        raise RuntimeError('Unexpected destination')
    if target['optimization'] != 'secondary' or not target['settingsReadBack']:
        raise RuntimeError('Destination verification missing')
    return manifest, target, case

def command(root, mode):
    # Respect the operator's existing proxy settings; never discover/change a host proxy.
    env = {**os.environ, 'GOOGLE_ACCEPTANCE_ROOT': str(root)}
    args = (['/usr/bin/python3', str(SCRIPTS / 'refresh-oauth.py')] if mode == 'refresh'
            else [NODE, '--use-env-proxy', str(SCRIPTS / 'google-acceptance.mjs'), mode])
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=95)
    with (root / 'private/job-process.log').open('a') as stream:
        stream.write('\n' + mode + '\n' + result.stdout + result.stderr)
    return result.returncode == 0

def execute(root=ROOT, now=None, run=None, check_only=False):
    now = now or dt.datetime.now(dt.timezone.utc)
    run = run or (lambda mode: command(root, mode))
    manifest, target, case = guard(root)
    previous_path = root / 'evidence/google-job-status.json'
    status = read(previous_path) if previous_path.exists() else {}
    status.update({'checkedAt': now.isoformat(), 'accountId': target['accountId'],
                   'actionId': target['actionId'], 'eventId': case['eventId'],
                   'uploadNotBefore': target['uploadNotBefore'], 'realUploadAttempts': case.get('realPostCount', 0),
                   'matching': 'unknown', 'vpsConnected': False, 'vpsModified': False})
    if status.get('phase') in TERMINAL:
        return status
    step = next_step(case, now, target, dt.datetime.fromisoformat(manifest['expiresAt']))
    status['phase'] = step
    if check_only:
        return {**status, 'checkOnly': True, 'networkRequests': 0}
    if step in {'expired', 'requires_reconciliation', 'waiting_for_target'}:
        atomic(previous_path, status)
        return status
    if not run('refresh'):
        status['phase'] = 'authorization_failed'
        atomic(previous_path, status)
        return status
    if step == 'validate_then_upload_once':
        status['validationAttemptsAfterWindow'] = status.get('validationAttemptsAfterWindow', 0) + 1
        if not run('validate'):
            # Only the specific new-target lookup error is retried, at most four times.
            lines = (root / 'evidence/google-transport.jsonl').read_text().splitlines()
            last = json.loads(lines[-1]) if lines else {}
            body = last.get('body', {})
            violations = [v for detail in body.get('error', {}).get('details', [])
                          for v in detail.get('fieldViolations', [])]
            fresh = (last.get('mode') == 'validate' and last.get('at') and
                     dt.datetime.fromisoformat(last['at'].replace('Z', '+00:00')) >= now)
            pending = fresh and bool(violations) and all(v.get('reason') == 'NOT_FOUND' and
                         'destination_references' in v.get('field', '') for v in violations)
            status['phase'] = ('waiting_for_api_target' if pending and status['validationAttemptsAfterWindow'] < 4
                               else 'validation_failed')
            status['validation'] = 'failed'
            atomic(previous_path, status)
            return status
        status['validation'] = 'passed'
        # Re-check immutable source/approval/code immediately before the only allowed upload.
        guard(root)
        ok = run('upload')
        case = read(root / 'private/google-case.json')
        status['realUploadAttempts'] = case.get('realPostCount', 0)
        if not ok or not case.get('requestId'):
            status['phase'] = 'requires_reconciliation' if case.get('realPostCount') else 'guard_failed'
            upload_path = root / 'evidence/google-upload.json'
            if upload_path.exists() and read(upload_path).get('delivery', {}).get('receiptStages', {}).get('acceptance') == 'rejected':
                status['phase'] = 'upload_rejected'
            atomic(previous_path, status)
            return status
        if not run('replay'):
            status['phase'] = 'replay_failed'
            status['requestId'] = case['requestId']
            atomic(previous_path, status)
            return status
    case = read(root / 'private/google-case.json')
    status.update({'requestId': case['requestId'], 'acceptance': 'accepted', 'realUploadAttempts': case['realPostCount']})
    if run('status'):
        receipt = read(root / 'evidence/google-processing.json')['receiptStages']
        status['receiptStages'] = receipt
        processing = receipt.get('processing', 'unknown')
        status['phase'] = ('processed' if processing == 'success' else
                           'processing_failed' if processing in {'failed', 'partial_success'} else 'processing')
    else:
        status['phase'] = 'processing'
        status['lastStatusRead'] = 'unavailable; accepted request is never uploaded again'
    atomic(previous_path, status)
    return status

def main():
    if not os.environ.get('GOOGLE_ACCEPTANCE_ROOT'):
        raise SystemExit('GOOGLE_ACCEPTANCE_ROOT is required')
    if '--check' not in sys.argv and os.environ.get('GOOGLE_OFFLINE_LIVE_ENABLED') != 'true':
        raise SystemExit('GOOGLE_OFFLINE_LIVE_ENABLED=true is required for network operations')
    with (ROOT / 'private/job.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'phase': 'another_run_holds_lock', 'networkRequests': 0}))
            return
        try:
            result = execute(check_only='--check' in sys.argv)
        except Exception as error:
            result = {'phase': 'guard_failed', 'errorType': type(error).__name__,
                      'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'noBlindRetry': True,
                      'vpsConnected': False, 'vpsModified': False}
            atomic(ROOT / 'evidence/google-job-status.json', result)
        if '--check' not in sys.argv:
            updater = SCRIPTS / 'update-google-report.py'
            if updater.exists() and os.environ.get('GOOGLE_REPORT_ROOT'):
                subprocess.run(['/usr/bin/python3', str(updater)], check=True, timeout=120)
            if result['phase'] in TERMINAL:
                subprocess.run(['systemctl', '--user', 'stop', TIMER], check=False, capture_output=True)
        print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
