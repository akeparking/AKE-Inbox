import { Inject, Injectable } from "@nestjs/common";
import { redactPayload } from "../common/http";
import { REVENUE_STORE, type RevenueStore } from "../store/store.types";
import { AdapterError, adapterFor } from "./adapters";
import { loadConfig } from '../config';

@Injectable()
export class ConversionService {
  private lastReceiptCheck=0;
  constructor(@Inject(REVENUE_STORE) private readonly store: RevenueStore) {}

  list(workspaceId: string) {
    return this.store.listDeliveries(workspaceId);
  }

  replay(workspaceId: string, deliveryId: string) {
    return this.store.replayDelivery(workspaceId, deliveryId);
  }

  async processBatch(limit = 25) {
    if (process.env.QUALIFIED_FEEDBACK_ENABLED === 'false') return [];
    const mode = loadConfig().adsMode;
    // Poll accepted requests without uploading them again. Matching remains unknown.
    if(mode==='live'&&Date.now()-this.lastReceiptCheck>60000){this.lastReceiptCheck=Date.now();
      for(const d of (await this.store.listDeliveries(loadConfig().defaultWorkspaceId)).filter(d=>d.provider==='google'&&d.mode==='live'&&d.status==='accepted'&&d.providerResponseId&&['unknown','processing'].includes(d.receiptStages?.processing||'unknown')).slice(0,25)){
        const adapter=adapterFor(d.provider,d.mode);if(adapter.queryReceipt)try{const stages=await adapter.queryReceipt(d.providerResponseId!);await this.store.updateDelivery(d.id,{receiptStages:stages,diagnosticStatus:['failed','partial_success'].includes(stages.processing)?'warning':'unknown'});}catch{/* Preserve the last known receipt; never infer success from a polling failure. */}
      }
    }
    const deliveries = await this.store.claimPendingDeliveries(limit, mode);
    const results = [];
    for (const delivery of deliveries) {
      // Legacy Live Meta work must be reconciled, including work claimed before an upgrade.
      if (delivery.provider === 'meta' && delivery.mode === 'live') {
        results.push(await this.store.updateDelivery(delivery.id, {
          status: 'review', providerErrorCode: 'META_LEGACY_REVIEW_REQUIRED', nextRetryAt: undefined,
          providerErrorMessage: 'Use reviewed Meta feedback after reconciling the legacy receipt',
        }));
        continue;
      }
      const context = await this.store.getQualifiedContext(delivery.id);
      if (!context) {
        results.push(await this.store.updateDelivery(delivery.id, { status: "dead_letter", providerErrorCode: "CONTEXT_MISSING", providerErrorMessage: "Qualified context is missing" }));
        continue;
      }
      const adapter = adapterFor(delivery.provider, delivery.mode);
      let payload: Record<string, unknown> = {};
      try {
        if (delivery.mode === "live" && (context.lead.isTest || context.lead.rawAttribution.consentStatus !== "granted")) throw new AdapterError("Live delivery requires a non-test lead and granted consent", "LIVE_GUARD", false);
        payload = adapter.buildQualifiedPayload(context);
        const sent = await adapter.send(payload);
        results.push(
          await this.store.updateDelivery(delivery.id, {
            status: sent.validatedOnly ? 'validated' : "accepted",
            diagnosticStatus: sent.diagnosticStatus,
            attemptCount: delivery.attemptCount + 1,
            providerResponseId: sent.responseId,
            receiptStages: sent.receiptStages,
            payloadPreview: redactPayload(payload) as Record<string, unknown>,
          }),
        );
      } catch (error) {
        const adapterError = error instanceof AdapterError ? error : new AdapterError(error instanceof Error ? error.message : "Unknown adapter error", "UNEXPECTED", true);
        const attempts = delivery.attemptCount + 1;
        const dead = !adapterError.retryable || attempts >= 5;
        const delayMinutes = [1, 5, 15, 60, 240][Math.min(attempts - 1, 4)];
        results.push(
          await this.store.updateDelivery(delivery.id, {
            status: adapterError.uncertain ? 'review' : dead ? "dead_letter" : "retrying",
            attemptCount: attempts,
            nextRetryAt: dead ? undefined : new Date(Date.now() + delayMinutes * 60_000).toISOString(),
            providerErrorCode: adapterError.code,
            providerErrorMessage: adapterError.message,
            receiptStages: {validation:adapterError.uncertain?'unknown':'failed',acceptance:adapterError.uncertain?'uncertain':'rejected',processing:'unknown',matching:'unknown'},
            payloadPreview: redactPayload(payload) as Record<string, unknown>,
          }),
        );
      }
    }
    return results;
  }
}
