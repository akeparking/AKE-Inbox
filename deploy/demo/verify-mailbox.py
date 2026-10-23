"""Verify IMAP and SMTP credentials without sending mail or printing secrets."""
import imaplib
import json
import os
import pathlib
import smtplib
import ssl
import sys

config = json.load(sys.stdin)
mail = config['email']
status = {}
try:
    with imaplib.IMAP4_SSL(mail['imap_host'], 993, ssl_context=ssl.create_default_context(), timeout=25) as client:
        client.login(mail['address'], mail['password'])
        result, counts = client.select('INBOX', readonly=True)
        assert result == 'OK'
        status['imap_auth'] = 'ok'
        status['inbox_messages'] = int(counts[0])
    with smtplib.SMTP_SSL(mail['smtp_host'], 465, context=ssl.create_default_context(), timeout=25) as client:
        client.ehlo()
        client.login(mail['address'], mail['password'])
        status['smtp_auth'] = 'ok'
    path = pathlib.Path('/opt/ai-sales-demo/private/mailbox-setup.json')
    fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(config, stream)
    print(json.dumps({**status, 'test_email_sent': False, 'ready_to_configure': True}))
except Exception as error:
    print(json.dumps({**status, 'error_type': type(error).__name__, 'ready_to_configure': False}))
    sys.exit(1)
