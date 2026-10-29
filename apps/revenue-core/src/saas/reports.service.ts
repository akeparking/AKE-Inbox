import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { REVENUE_STORE, type RevenueStore } from "../store/store.types";
import { currentTenant } from "./context";
import { TenantsService } from "./tenants.service";

export function amountMicros(value: string | number) {
  const [whole, frac = ""] = String(value).split(".");
  return BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
}
export function amountString(value: bigint) {
  return `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, "0")}`;
}
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenants: TenantsService,
    @Inject(REVENUE_STORE) private readonly store: RevenueStore,
  ) {}
  async report(query: any) {
    const v = z
      .object({
        from: z.iso.date(),
        to: z.iso.date(),
        model: z.enum(["first", "last_non_direct"]).default("last_non_direct"),
        mode: z.enum(["mock", "live"]).default("live"),
      })
      .parse(query);
    if (v.from > v.to || Date.parse(v.to) - Date.parse(v.from) > 366 * 86400000)
      throw new BadRequestException("invalid_report_period");
    const a = currentTenant(),
      zone = a.settings.timezone || "UTC";
    const leads = (
      await this.tenants.db.query(
        `SELECT l.*,EXISTS(SELECT 1 FROM conversion_events e WHERE e.workspace_id=l.workspace_id AND e.primary_source_lead_id=l.id AND e.event_type='LeadQualified') AS qualified
      FROM leads l WHERE l.workspace_id=$1 AND l.is_test=$4 AND (coalesce(l.received_at,l.created_at) AT TIME ZONE $5)::date BETWEEN $2 AND $3
      AND EXISTS(SELECT 1 FROM crm_ingestion_receipts r WHERE r.workspace_id=l.workspace_id AND r.lead_id=l.id AND r.state='persisted') ORDER BY l.id LIMIT 10001`,
        [a.workspaceId, v.from, v.to, v.mode === "mock", zone],
      )
    ).rows;
    if (leads.length > 10000)
      throw new BadRequestException("narrow_report_period");
    const leadIds = leads.map((l) => l.id);
    const opportunities = (
      await this.tenants.db.query(
        `SELECT o.*,last_outcome.amount AS won_amount,last_outcome.currency AS won_currency,last_outcome.status AS outcome_status
      FROM opportunities o LEFT JOIN LATERAL(SELECT amount,currency,status FROM crm_outcomes WHERE workspace_id=o.workspace_id AND opportunity_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) last_outcome ON true
      WHERE o.workspace_id=$1 AND o.primary_source_lead_id=ANY($2)`,
        [a.workspaceId, leadIds],
      )
    ).rows;
    const metrics = (
      await this.tenants.db.query(
        `SELECT c.id,c.provider,c.account_id,c.currency,c.timezone,c.mode,c.status,m.campaign_id,max(m.campaign_name) AS campaign_name,
      CASE WHEN bool_and(m.spend IS NOT NULL) THEN sum(m.spend)::text END AS spend,
      CASE WHEN bool_and(m.impressions IS NOT NULL) THEN sum(m.impressions)::text END AS impressions,
      CASE WHEN bool_and(m.clicks IS NOT NULL) THEN sum(m.clicks)::text END AS clicks,
      CASE WHEN bool_and(m.platform_conversions IS NOT NULL) THEN sum(m.platform_conversions)::text END AS platform_conversions,
      bool_and(m.complete) AS rows_complete,count(DISTINCT m.date)::integer AS days_with_rows,max(m.synced_at) AS synced_at
      FROM ad_connections c JOIN ad_metric_daily m ON m.connection_id=c.id AND m.workspace_id=c.workspace_id
      WHERE c.workspace_id=$1 AND m.date BETWEEN $2 AND $3 AND c.mode=$4 GROUP BY c.id,m.campaign_id`,
        [a.workspaceId, v.from, v.to, v.mode],
      )
    ).rows;
    const coverage = (
      await this.tenants.db.query(
        "SELECT connection_id,count(*)::int AS days FROM ad_sync_days WHERE workspace_id=$1 AND date BETWEEN $2 AND $3 GROUP BY connection_id",
        [a.workspaceId, v.from, v.to],
      )
    ).rows;
    const connections = (
      await this.tenants.db.query(
        "SELECT id,name,provider,account_id,mode,status,last_sync_at,currency,timezone FROM ad_connections WHERE workspace_id=$1 AND mode=$2",
        [a.workspaceId, v.mode],
      )
    ).rows;
    const expectedDays = 1 + (Date.parse(v.to) - Date.parse(v.from)) / 86400000;
    const groups = new Map<string, any>();
    for (const m of metrics)
      groups.set([m.provider, m.account_id, m.campaign_id].join(":"), {
        ...m,
        complete:
          m.rows_complete &&
          coverage.find((c) => c.connection_id === m.id)?.days ===
            expectedDays &&
          ["verified", "mock_verified"].includes(m.status),
        leads: 0,
        qualified: 0,
        opportunities: 0,
        won: 0,
        wonAmount: null,
        wonMicros: 0n,
        amountMismatch: false,
        cohortTimezone: zone,
      });
    let unattributed = 0;
    for (const lead of leads) {
      const touches = (
        await this.tenants.db.query(
          "SELECT * FROM attribution_touches WHERE workspace_id=$1 AND lead_id=$2 ORDER BY occurred_at,id",
          [a.workspaceId, lead.id],
        )
      ).rows;
      const nonDirect = touches.filter(
        (t) =>
          ["meta", "google"].includes(t.provider) ||
          (t.utm?.utm_source &&
            !["direct", "(direct)"].includes(t.utm.utm_source)) ||
          Boolean(t.referrer),
      );
      const touch =
        v.model === "first" ? touches[0] : nonDirect.at(-1) || touches.at(-1);
      if (!touch) {
        unattributed++;
        continue;
      }
      const identifier = (
        await this.tenants.db.query(
          "SELECT value_ciphertext FROM ad_identifiers WHERE workspace_id=$1 AND attribution_touch_id=$2 AND identifier_type='campaign_id' LIMIT 1",
          [a.workspaceId, touch.id],
        )
      ).rows[0];
      const campaign =
        touch.metadata?.campaignId ||
        (identifier
          ? this.tenants
              .cipher(a.workspaceId)
              .decrypt(identifier.value_ciphertext)
          : undefined);
      const account = touch.metadata?.accountId;
      const key = [touch.provider, account, campaign].join(":");
      if (
        !["meta", "google"].includes(touch.provider) ||
        !/^\d+$/.test(String(account || "")) ||
        !/^\d+$/.test(String(campaign || ""))
      ) {
        unattributed++;
        continue;
      }
      // Known acquisition does not become "unattributed" just because spend is unavailable.
      if (!groups.has(key)) {
        const connection = connections.find(
          (c) =>
            c.provider === touch.provider && c.account_id === String(account),
        );
        groups.set(key, {
          id: connection?.id || "source:" + touch.provider + ":" + account,
          provider: touch.provider,
          account_id: String(account),
          campaign_id: String(campaign),
          campaign_name: String(campaign),
          currency: connection?.currency || null,
          timezone: connection?.timezone || null,
          mode: v.mode,
          status: connection?.status || "connection_missing",
          spend: null,
          impressions: null,
          clicks: null,
          platform_conversions: null,
          rows_complete: false,
          complete: false,
          days_with_rows: 0,
          synced_at: null,
          leads: 0,
          qualified: 0,
          opportunities: 0,
          won: 0,
          wonAmount: null,
          wonMicros: 0n,
          amountMismatch: false,
          cohortTimezone: zone,
        });
      }
      const group = groups.get(key);
      group.leads++;
      if (lead.qualified) group.qualified++;
      const deals = opportunities.filter(
        (o) => o.primary_source_lead_id === lead.id,
      );
      group.opportunities += deals.length;
      for (const deal of deals.filter(
        (o) => o.stage === "won" && o.outcome_status === "won",
      )) {
        group.won++;
        if (deal.won_currency === group.currency && deal.won_amount !== null)
          group.wonMicros += amountMicros(deal.won_amount);
        else group.amountMismatch = true;
      }
    }
    const rows = [...groups.values()].map((g) => {
      const { wonMicros, ...rest } = g;
      const aligned = g.timezone === zone && !g.amountMismatch;
      return {
        ...rest,
        wonAmount: g.won && !g.amountMismatch ? amountString(wonMicros) : null,
        costPerQualified:
          aligned && g.complete && g.qualified && g.spend !== null
            ? Number(g.spend) / g.qualified
            : null,
        wonToSpend:
          aligned && g.complete && g.won && Number(g.spend) > 0
            ? Number(amountString(wonMicros)) / Number(g.spend)
            : null,
        ratioUnavailableReason: !g.complete
          ? "sync_incomplete"
          : !aligned
            ? "currency_or_timezone_mismatch"
            : !g.won
              ? "no_confirmed_win"
              : !Number(g.spend)
                ? "spend_missing_or_zero"
                : null,
      };
    });
    const wins = opportunities.filter(
      (o) => o.stage === "won" && o.outcome_status === "won",
    );
    const revenue: Record<string, bigint> = {};
    for (const win of wins) {
      if (win.won_amount !== null && win.won_currency)
        revenue[win.won_currency] =
          (revenue[win.won_currency] || 0n) + amountMicros(win.won_amount);
    }
    const activity = (
      await this.tenants.db.query(
        `SELECT count(*) FILTER(WHERE status='open' AND due_at<now())::integer AS overdue FROM crm_tasks WHERE workspace_id=$1`,
        [a.workspaceId],
      )
    ).rows[0];
    return {
      period: v,
      cohortTimezone: zone,
      asOf: new Date().toISOString(),
      summary: {
        inquiries: leads.length,
        qualified: leads.filter((l) => l.qualified).length,
        opportunities: opportunities.length,
        won: wins.length,
        unattributed,
        overdue: activity.overdue,
        wonAmountByCurrency: Object.fromEntries(
          Object.entries(revenue).map(([k, n]) => [k, amountString(n)]),
        ),
      },
      campaigns: rows,
      connections,
      definitions: {
        inquiries: "按收件日期形成的询盘群组，排除未成功持久收件",
        won: "该群组截至查询时仍有效的赢单，不等同财务收入",
        spend: "各广告账户本地日期与原币种；空值表示未取得",
        attribution: "保留真实触点；缺少账户或系列标识时不按名称猜测匹配",
        platformConversions: "平台自身口径，与 CRM 人工有效询盘分别展示",
      },
    };
  }
}
