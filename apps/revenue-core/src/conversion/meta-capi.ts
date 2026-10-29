import { AdapterError } from './adapter-error';
import type { AdapterResult } from './adapters';
import type { AppConfig } from '../config';

// A server-only transport. Neither URLs nor stored errors contain credentials/PII.
export async function sendMetaCapi(config: AppConfig['meta'], payload: Record<string, any>): Promise<AdapterResult> {
  if (!config.accessToken || !/^\d{5,30}$/.test(config.datasetId || '') || !/^v\d+\.0$/.test(config.graphVersion)) {
    throw new AdapterError('Meta 凭据、数据集或 API 版本未配置完整', 'META_CONFIG', false);
  }
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.datasetId}/events`, {
      method: 'POST', headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20000), redirect: 'error',
    });
  } catch {
    throw new AdapterError('发送结果未知，请核对后处理', 'META_OUTCOME_UNKNOWN', false, true);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = Number.isInteger(body?.error?.code) ? String(body.error.code) : `HTTP_${response.status}`;
    throw new AdapterError('Meta 拒绝了本次回传', `META_${code}`, response.status === 429,
      response.status >= 500 || !body?.error);
  }
  if (body?.error || body?.events_received !== payload.data?.length || !/^[\w-]{1,200}$/.test(body?.fbtrace_id || '')) {
    throw new AdapterError('未取得完整受理回执，请核对后处理', 'META_RECEIPT_INCOMPLETE', false, true);
  }
  return { responseId: body.fbtrace_id, diagnosticStatus: 'unknown', receiptStages: {
    validation: 'passed', acceptance: 'accepted', processing: 'unknown', matching: 'unknown',
  } };
}
