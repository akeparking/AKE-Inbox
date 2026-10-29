import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { currentTenant } from "./context";
import { TenantsService, digest } from "./tenants.service";
import {
  REVENUE_STORE,
  type RevenueStore,
  type QualifiedContext,
} from "../store/store.types";
import {
  GoogleAdsAdapter,
  MetaAdsAdapter,
  AdapterError,
} from "../conversion/adapters";
import { loadConfig } from "../config";
import { googleFeedbackCredentials } from "./google-oauth";

/** A durable send intent precedes every outbound request. Unknown results require reconciliation. */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly tenants: TenantsService,
    @Inject(REVENUE_STORE) private readonly store: RevenueStore,
  ) {}
  async list() {
    const a = currentTenant();
    const items = (
      await this.tenants.db.query(
        `SELECT 'qualified' AS kind,d.id,d.provider,d.mode,d.occurred_at AS "occurredAt",d.event_key,
      coalesce(f.state,d.status) AS state,f.receipt,d.skipped_reason,f.error_code AS "errorCode",
      (f.event_key IS NULL AND d.status='pending') AS sendable
      FROM conversion_deliveries d LEFT JOIN crm_feedback_attempts f ON f.workspace_id=d.workspace_id AND f.event_key=d.event_key
      WHERE d.workspace_id=$1
      UNION ALL SELECT 'won',e.id,l.provider,e.mode,e.occurred_at,e.id,coalesce(f.state,e.status),f.receipt,NULL,f.error_code,
      (f.event_key IS NULL AND e.status='pending') AS sendable
      FROM crm_business_events e JOIN leads l ON l.id=e.lead_id AND l.workspace_id=e.workspace_id
      LEFT JOIN crm_feedback_attempts f ON f.workspace_id=e.workspace_id AND f.event_key=e.id
      WHERE e.workspace_id=$1 ORDER BY "occurredAt" DESC LIMIT 200`,
        [a.workspaceId],
      )
    ).rows;
    return { items };
  }
  async rearmRejected(kind: string, id: string, body: unknown) {
    this.tenants.requireRole("admin", "marketing");
    const v = z
        .object({
          confirmed: z.literal(true),
          reason: z.string().trim().min(3).max(1000),
        })
        .parse(body),
      a = currentTenant(),
      event = await this.event(kind, id);
    if (!["pending", "rejected"].includes(event.state))
      throw new ConflictException("business_event_not_retryable");
    return this.tenants.transaction(async (db) => {
      const old = (
        await db.query(
          "SELECT * FROM crm_feedback_attempts WHERE workspace_id=$1 AND event_key=$2 FOR UPDATE",
          [a.workspaceId, event.key],
        )
      ).rows[0];
      if (
        !old ||
        old.state !== "rejected" ||
        ![
          "HTTP_401",
          "HTTP_403",
          "HTTP_429",
          "UNAUTHENTICATED",
          "PERMISSION_DENIED",
          "RESOURCE_EXHAUSTED",
        ].includes(old.error_code)
      )
        throw new ConflictException(
          "only_confirmed_authorization_or_rate_rejection_can_retry",
        );
      await db.query(
        "INSERT INTO crm_feedback_history(workspace_id,event_key,payload_hash,receipt,error_code,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          a.workspaceId,
          event.key,
          old.payload_hash,
          old.receipt,
          old.error_code,
          v.reason,
          a.userId,
        ],
      );
      await db.query(
        "DELETE FROM crm_feedback_attempts WHERE workspace_id=$1 AND event_key=$2",
        [a.workspaceId, event.key],
      );
      return { state: "pending", oldAttemptPreserved: true };
    });
  }
  private async event(kind: string, id: string) {
    const a = currentTenant();
    if (kind === "qualified") {
      const context = await this.store.getQualifiedContext(id);
      if (!context || context.delivery.workspaceId !== a.workspaceId)
        throw new NotFoundException();
      return {
        context,
        key: context.delivery.eventId,
        mode: context.delivery.mode,
        state: context.delivery.status,
        won: null as any,
        opportunityId: context.delivery.opportunityId,
      };
    }
    if (kind !== "won") throw new NotFoundException();
    const won = (
      await this.tenants.db.query(
        "SELECT * FROM crm_business_events WHERE workspace_id=$1 AND id=$2 AND kind='OpportunityWon'",
        [a.workspaceId, id],
      )
    ).rows[0];
    if (!won) throw new NotFoundException();
    const lead = await this.store.getLeadInternal(a.workspaceId, won.lead_id);
    if (!lead) throw new NotFoundException();
    const context = {
      lead,
      identifiers: lead.rawAttribution.identifiers,
      delivery: {
        id: won.id,
        eventId: won.id,
        occurredAt: new Date(won.occurred_at).toISOString(),
        mode: won.mode,
        provider: lead.provider,
      },
    } as QualifiedContext;
    return {
      context,
      key: won.id,
      mode: won.mode,
      state: won.status,
      won,
      opportunityId: won.opportunity_id,
    };
  }
  async send(kind: string, id: string, body: unknown) {
    this.tenants.requireRole("admin", "marketing");
    z.object({ confirmed: z.literal(true) }).parse(body);
    const a = currentTenant(),
      event = await this.event(kind, id),
      { context } = event;
    const prior = (
      await this.tenants.db.query(
        "SELECT state,receipt FROM crm_feedback_attempts WHERE workspace_id=$1 AND event_key=$2",
        [a.workspaceId, event.key],
      )
    ).rows[0];
    if (prior) return { ...prior, deduplicated: true };
    if (event.state !== "pending")
      throw new ConflictException("event_not_sendable");
    const provider = context.lead.provider;
    if (!["meta", "google"].includes(provider))
      throw new BadRequestException("attribution_required");
    const config = (await this.tenants.secretSettings()).feedback || {},
      adapterConfig = loadConfig();
    adapterConfig.adsMode = event.mode;
    adapterConfig.meta = { ...adapterConfig.meta, ...config.meta };
    adapterConfig.google = { ...adapterConfig.google, ...config.google };
    if (event.mode === "live") {
      const latest = (
        await this.tenants.db.query(
          "SELECT consent_status FROM attribution_touches WHERE workspace_id=$1 AND lead_id=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1",
          [a.workspaceId, context.lead.id],
        )
      ).rows[0];
      if (
        !config.enabled ||
        context.lead.isTest ||
        context.lead.rawAttribution.consentStatus !== "granted" ||
        latest?.consent_status === "denied"
      )
        throw new BadRequestException("live_authorization_or_consent_required");
      if (
        provider === "meta" &&
        (!/^\d+$/.test(config.meta?.datasetId || "") ||
          !/^v\d+\.\d+$/.test(config.meta?.graphVersion || ""))
      )
        throw new BadRequestException("meta_destination_required");
      if (provider === "google") {
        Object.assign(adapterConfig.google, await googleFeedbackCredentials(this.tenants));
        adapterConfig.google.conversionActionId =
          kind === "won"
            ? config.google?.wonConversionActionId
            : config.google?.conversionActionId;
        if (
          !/^\d+$/.test(adapterConfig.google.adsAccountId || "") ||
          !/^\d+$/.test(adapterConfig.google.conversionActionId || "")
        )
          throw new BadRequestException("google_destination_required");
      }
    }
    const adapter =
      provider === "google"
        ? new GoogleAdsAdapter(adapterConfig)
        : new MetaAdsAdapter(adapterConfig);
    if (event.mode === "live" && !(await adapter.validateConfiguration()).valid)
      throw new BadRequestException("feedback_credentials_required");
    let payload: any =
      event.mode === "mock"
        ? { mode: "mock", kind, eventKey: event.key }
        : adapter.buildQualifiedPayload(context);
    if (event.mode === "live" && provider === "meta") {
      if (kind === "won") {
        payload.data[0].event_name = "Purchase";
        payload.data[0].custom_data = {
          ...payload.data[0].custom_data,
          value: Number(event.won.payload.amount),
          currency: event.won.payload.currency,
          order_id: event.key,
        };
      }
      if (Date.now() - Date.parse(context.delivery.occurredAt) > 7 * 86400000)
        throw new BadRequestException("meta_event_outside_upload_window");
    }
    if (event.mode === "live" && provider === "google" && kind === "won")
      Object.assign(payload.events[0], {
        conversionValue: Number(event.won.payload.amount),
        currency: event.won.payload.currency,
      });
    const intent = await this.tenants.db.query(
      "INSERT INTO crm_feedback_attempts(workspace_id,event_key,provider,mode,state,payload_hash) VALUES($1,$2,$3,$4,'dispatching',$5) ON CONFLICT DO NOTHING RETURNING event_key",
      [
        a.workspaceId,
        event.key,
        provider,
        event.mode,
        digest(JSON.stringify(payload)),
      ],
    );
    if (!intent.rowCount) return { state: "dispatching", deduplicated: true };
    try {
      return await this.tenants.transaction(async (db) => {
        if (event.opportunityId)
          await db.query(
            "SELECT id FROM opportunities WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [a.workspaceId, event.opportunityId],
          );
        if (kind === "won") {
          const current = (
            await db.query(
              "SELECT status FROM crm_business_events WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
              [a.workspaceId, id],
            )
          ).rows[0];
          if (current?.status !== "pending")
            throw new ConflictException("outcome_changed");
        }
        let receipt: any;
        if (event.mode === "mock")
          receipt = {
            state: "accepted",
            responseId: "mock_" + digest(event.key).slice(0, 18),
            validation: "passed",
            acceptance: "mock",
            processing: "unknown",
            matching: "unknown",
          };
        else if (provider === "meta") {
          let response: Response;
          try {
            response = await fetch(
              `https://graph.facebook.com/${adapterConfig.meta.graphVersion}/${adapterConfig.meta.datasetId}/events`,
              {
                method: "POST",
                headers: {
                  authorization: "Bearer " + adapterConfig.meta.accessToken,
                  "content-type": "application/json",
                },
                body: JSON.stringify(payload),
                redirect: "error",
                signal: AbortSignal.timeout(20000),
              },
            );
          } catch {
            throw new AdapterError("unknown", "OUTCOME_UNKNOWN", false, true);
          }
          if (!response.ok)
            throw new AdapterError(
              "provider_rejected",
              "HTTP_" + response.status,
              false,
              response.status >= 500,
            );
          const result: any = await response.json();
          if (
            result?.error ||
            result?.events_received !== 1 ||
            !/^[\w-]{1,200}$/.test(result?.fbtrace_id || "")
          )
            throw new AdapterError(
              "unknown",
              "RECEIPT_INCOMPLETE",
              false,
              true,
            );
          receipt = {
            state: "accepted",
            responseId: String(result.fbtrace_id),
            validation: "passed",
            acceptance: "accepted",
            processing: "unknown",
            matching: "unknown",
          };
        } else {
          const result = await adapter.send(payload);
          receipt = {
            state: result.validatedOnly ? "validated" : "accepted",
            responseId: result.responseId || null,
            ...result.receiptStages,
          };
        }
        await db.query(
          "UPDATE crm_feedback_attempts SET state=$3,receipt=$4,updated_at=now() WHERE workspace_id=$1 AND event_key=$2",
          [a.workspaceId, event.key, receipt.state, receipt],
        );
        if (kind === "qualified")
          await db.query(
            "UPDATE conversion_deliveries SET status=$3,provider_response_id=$4,receipt_stages=$5,attempt_count=attempt_count+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
            [
              a.workspaceId,
              id,
              receipt.state,
              receipt.responseId || null,
              receipt,
            ],
          );
        else
          await db.query(
            "UPDATE crm_business_events SET status=$3 WHERE workspace_id=$1 AND id=$2",
            [a.workspaceId, id, receipt.state],
          );
        return { state: receipt.state, receipt };
      });
    } catch (e) {
      const error =
        e instanceof AdapterError
          ? e.code
          : e instanceof ConflictException
            ? "BUSINESS_EVENT_CHANGED"
            : "OUTCOME_UNKNOWN";
      const state =
        e instanceof ConflictException
          ? "cancelled"
          : e instanceof AdapterError && !e.uncertain
            ? "rejected"
            : "review";
      const receipt = {
        validation: "unknown",
        acceptance:
          state === "review"
            ? "uncertain"
            : state === "cancelled"
              ? "not_attempted"
              : "rejected",
        processing: "unknown",
        matching: "unknown",
      };
      await this.tenants.db.query(
        "UPDATE crm_feedback_attempts SET state=$3,error_code=$4,receipt=$5,updated_at=now() WHERE workspace_id=$1 AND event_key=$2",
        [a.workspaceId, event.key, state, error, receipt],
      );
      return { state, receipt, error };
    }
  }
  async reconcile() {
    const a = currentTenant();
    await this.tenants.db.query(
      "UPDATE crm_feedback_attempts SET state='review',error_code='INTERRUPTED_OUTCOME_UNKNOWN' WHERE workspace_id=$1 AND state='dispatching' AND updated_at<now()-interval '2 minutes'",
      [a.workspaceId],
    );
    let google = (await this.tenants.secretSettings()).feedback?.google;
    if (!google?.accessToken) return;
    const rows = (
      await this.tenants.db.query(
        "SELECT * FROM crm_feedback_attempts WHERE workspace_id=$1 AND provider='google' AND mode='live' AND state='accepted' AND coalesce(receipt->>'processing','unknown') IN ('unknown','processing') AND updated_at<now()-interval '1 minute' LIMIT 20",
        [a.workspaceId],
      )
    ).rows;
    if (!rows.length) return;
    google = await googleFeedbackCredentials(this.tenants);
    for (const row of rows) {
      const config = loadConfig();
      config.google = {
        ...config.google,
        ...google,
        conversionActionId: row.event_key.startsWith("qualified:")
          ? google.conversionActionId
          : google.wonConversionActionId,
      };
      try {
        const receipt = await new GoogleAdsAdapter(config).queryReceipt(
          row.receipt.responseId,
        );
        await this.tenants.db.query(
          "UPDATE crm_feedback_attempts SET receipt=$3,updated_at=now() WHERE workspace_id=$1 AND event_key=$2",
          [a.workspaceId, row.event_key, { ...row.receipt, ...receipt }],
        );
      } catch {
        /* Preserve prior receipt; never re-upload. */
      }
    }
  }
}
