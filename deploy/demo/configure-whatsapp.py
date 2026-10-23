"""Provision an isolated database and secrets for the WhatsApp Web connector."""
import json
import os
from pathlib import Path
import secrets
import subprocess

root = Path.cwd()
private = root / 'private'
path = private / 'whatsapp-config.json'
if path.exists():
    config = json.loads(path.read_text())
else:
    config = {key: secrets.token_hex(32) for key in ['api_key', 'database_password', 'archive_key']}
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(config, output)

def pg(sql, database='postgres'):
    result = subprocess.run(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database,
                             '-v', 'ON_ERROR_STOP=1', '-tA'], input=sql, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('database_setup_failed')
    return result.stdout.strip()

pg("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='whatsapp_web') THEN CREATE ROLE whatsapp_web LOGIN PASSWORD '" + config['database_password'] + "'; END IF; END $$;")
if not pg("SELECT 1 FROM pg_database WHERE datname='whatsapp_web'"):
    pg('CREATE DATABASE whatsapp_web OWNER whatsapp_web;')

redis = {}
for line in (private / 'redis.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        redis[key] = value.strip().strip('\"\'')

env = {
    'SERVER_TYPE': 'http', 'SERVER_PORT': '8080', 'SERVER_URL': 'http://whatsapp-web:8080',
    'AUTHENTICATION_API_KEY': config['api_key'], 'AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES': 'false',
    'DATABASE_PROVIDER': 'postgresql',
    'DATABASE_CONNECTION_URI': 'postgresql://whatsapp_web:' + config['database_password'] + '@postgres:5432/whatsapp_web?schema=public&connection_limit=4',
    'DATABASE_CONNECTION_CLIENT_NAME': 'ake_inbox',
    'DATABASE_SAVE_DATA_INSTANCE': 'true', 'DATABASE_SAVE_DATA_NEW_MESSAGE': 'true',
    'DATABASE_SAVE_MESSAGE_UPDATE': 'true', 'DATABASE_SAVE_DATA_CONTACTS': 'true',
    'DATABASE_SAVE_DATA_CHATS': 'true', 'DATABASE_SAVE_DATA_HISTORIC': 'true',
    'DATABASE_DELETE_MESSAGE': 'false',
    'CACHE_REDIS_ENABLED': 'true', 'CACHE_REDIS_URI': 'redis://:' + redis['REDIS_PASSWORD'] + '@redis:6379/2',
    'CACHE_REDIS_PREFIX_KEY': 'ake_whatsapp', 'CACHE_REDIS_SAVE_INSTANCES': 'false', 'CACHE_LOCAL_ENABLED': 'false',
    'CHATWOOT_ENABLED': 'true', 'CHATWOOT_MESSAGE_READ': 'true', 'CHATWOOT_MESSAGE_DELETE': 'false',
    'CHATWOOT_BOT_CONTACT': 'true', 'CHATWOOT_IMPORT_PLACEHOLDER_MEDIA_MESSAGE': 'false',
    'TELEMETRY_ENABLED': 'false', 'PROMETHEUS_METRICS': 'false', 'SENTRY_DSN': '',
    'RABBITMQ_ENABLED': 'false', 'SQS_ENABLED': 'false', 'KAFKA_ENABLED': 'false',
    'WEBSOCKET_ENABLED': 'false', 'WEBHOOK_GLOBAL_ENABLED': 'false', 'S3_ENABLED': 'false',
    'OPENAI_ENABLED': 'false', 'TYPEBOT_ENABLED': 'false', 'DIFY_ENABLED': 'false',
    'N8N_ENABLED': 'false', 'EVOAI_ENABLED': 'false', 'DEL_INSTANCE': 'false',
    'LOG_LEVEL': 'ERROR,WARN', 'LOG_BAILEYS': 'error', 'LOG_COLOR': 'false',
    'LANGUAGE': 'en', 'QRCODE_LIMIT': '5', 'NODE_OPTIONS': '--max-old-space-size=256',
}
env_file = private / 'whatsapp.env'
fd = os.open(env_file, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write('\n'.join(k + '=' + v for k, v in env.items()) + '\n')
print(json.dumps({'database': 'whatsapp_web', 'configured': True, 'public_port': False}))
