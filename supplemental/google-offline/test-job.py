import datetime as dt
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('google_job', Path(__file__).with_name('google-job.py'))
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)

class AcceptanceGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ake-google-guard-')
        self.root = Path(self.temp.name)
        for name in ['private', 'evidence']:
            (self.root / name).mkdir()
        self.now = dt.datetime.now(dt.timezone.utc)
        self.target = {'accountId': '0000000000', 'actionId': '0000000001', 'optimization': 'secondary',
                       'settingsReadBack': True, 'uploadNotBefore': (self.now - dt.timedelta(seconds=1)).isoformat()}
        job.atomic(self.root / 'evidence/google-conversion-target.json', self.target)
        self.case = {'eventId': 'fictional-stable-event', 'deliveryId': 'fictional-delivery', 'realPostCount': 0}
        job.atomic(self.root / 'private/google-case.json', self.case)
        self.source = self.root / 'private/approved.txt'; self.source.write_text('approved local test')
        job.atomic(self.root / 'private/execution-manifest.json', {
            'files': [{'path': str(self.source), 'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest()}],
            'eventId': self.case['eventId'], 'deliveryId': self.case['deliveryId'],
            'target': {'accountId': self.target['accountId'], 'actionId': self.target['actionId']},
            'expiresAt': (self.now + dt.timedelta(days=2)).isoformat()})
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def run_mode(self, mode):
        self.calls.append(mode)
        if mode == 'upload':
            current = job.read(self.root / 'private/google-case.json')
            self.assertEqual(current['realPostCount'], 0)
            current.update(realPostCount=1, requestId='fictional-request')
            job.atomic(self.root / 'private/google-case.json', current)
        if mode == 'status':
            job.atomic(self.root / 'evidence/google-processing.json', {
                'receiptStages': {'validation': 'passed', 'acceptance': 'accepted',
                                  'processing': 'success', 'matching': 'unknown'}})
        return True

    def execute(self, run=None, now=None):
        return job.execute(self.root, now or self.now, run or self.run_mode)

    def test_before_propagation_window_does_not_use_network(self):
        result = self.execute(now=self.now - dt.timedelta(hours=1))
        self.assertEqual(result['phase'], 'waiting_for_target')
        self.assertEqual(self.calls, [])

    def test_uncertain_upload_never_replays(self):
        self.case['realPostCount'] = 1
        job.atomic(self.root / 'private/google-case.json', self.case)
        self.assertEqual(self.execute()['phase'], 'requires_reconciliation')
        self.assertEqual(self.calls, [])

    def test_validation_error_stops_before_upload_and_is_bounded(self):
        def fail_validation(mode):
            self.calls.append(mode)
            if mode == 'validate':
                row = {'mode': 'validate', 'at': self.now.isoformat(), 'body': {'error': {'details': [
                    {'fieldViolations': [{'field': 'events.events[0].destination_references', 'reason': 'NOT_FOUND'}]}]}}}
                (self.root / 'evidence/google-transport.jsonl').write_text(json.dumps(row) + '\n')
                return False
            return True
        for i in range(4):
            result = self.execute(fail_validation)
            self.assertEqual(result['phase'], 'waiting_for_api_target' if i < 3 else 'validation_failed')
        self.assertNotIn('upload', self.calls)
        before = len(self.calls); self.execute(fail_validation)
        self.assertEqual(len(self.calls), before)

    def test_complete_processing_and_repeated_timer_count_once(self):
        result = self.execute()
        self.assertEqual(result['phase'], 'processed')
        self.assertEqual(result['matching'], 'unknown')
        self.execute()
        self.assertEqual(self.calls, ['refresh', 'validate', 'upload', 'replay', 'status'])
        self.assertEqual(job.read(self.root / 'private/google-case.json')['realPostCount'], 1)

    def test_existing_request_is_read_only_status(self):
        self.case.update(realPostCount=1, requestId='fictional-request')
        job.atomic(self.root / 'private/google-case.json', self.case)
        self.assertEqual(self.execute()['phase'], 'processed')
        self.assertEqual(self.calls, ['refresh', 'status'])

    def test_changed_approved_input_blocks_every_request(self):
        self.source.write_text('changed')
        with self.assertRaises(RuntimeError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_expired_job_stays_closed(self):
        self.assertEqual(self.execute(now=self.now + dt.timedelta(days=3))['phase'], 'expired')
        self.assertEqual(self.calls, [])

    def test_expired_authorization_does_not_validate_or_upload(self):
        def fail_refresh(mode):
            self.calls.append(mode)
            return False
        self.assertEqual(self.execute(fail_refresh)['phase'], 'authorization_failed')
        self.assertEqual(self.calls, ['refresh'])

    def test_changed_destination_stops_before_any_network_operation(self):
        self.target['accountId'] = '0000000002'
        job.atomic(self.root / 'evidence/google-conversion-target.json', self.target)
        with self.assertRaises(RuntimeError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_manifest_without_destination_fails_closed(self):
        manifest = job.read(self.root / 'private/execution-manifest.json')
        del manifest['target']
        job.atomic(self.root / 'private/execution-manifest.json', manifest)
        with self.assertRaises(RuntimeError):
            self.execute()
        self.assertEqual(self.calls, [])

if __name__ == '__main__':
    unittest.main(verbosity=2)
