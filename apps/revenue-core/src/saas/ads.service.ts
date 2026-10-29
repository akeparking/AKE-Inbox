import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { adConnectionSchema, type AdMetricRow } from "@ake/contracts";
import { currentTenant } from "./context";
import { TenantsService } from "./tenants.service";

export class AdsReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const decimal = (v: any): string | null =>
  v === undefined || v === null
    ? null
    : /^\d+(?:\.\d+)?$/.test(String(v))
      ? String(v)
      : (() => {
          throw new AdsReadError("invalid_metric");
        })();
export function micros(v: any): string | null {
  const value = decimal(v);
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new AdsReadError("invalid_cost_micros");
  const n = BigInt(value);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")}`;
}
export function metaRow(r: any, conversionMetric: string): AdMetricRow {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(r.date_start) ||
    !/^\d+$/.test(String(r.campaign_id))
  )
    throw new AdsReadError("invalid_dimensions");
  const conversion =
    conversionMetric && Array.isArray(r.actions)
      ? r.actions.find((x: any) => x.action_type === conversionMetric)?.value
      : undefined;
  return {
    date: r.date_start,
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name || ""),
    spend: decimal(r.spend),
    impressions: decimal(r.impressions),
    clicks: decimal(r.clicks),
    platformConversions: decimal(conversion),
  };
}
export function googleRow(r: any): AdMetricRow {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(r.segments?.date) ||
    !/^\d+$/.test(String(r.campaign?.id))
  )
    throw new AdsReadError("invalid_dimensions");
  return {
    date: r.segments.date,
    campaignId: String(r.campaign.id),
    campaignName: String(r.campaign.name || ""),
    spend: micros(r.metrics?.costMicros),
    impressions: decimal(r.metrics?.impressions),
    clicks: decimal(r.metrics?.clicks),
    platformConversions: decimal(r.metrics?.conversions),
  };
}
export function localDate(zone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
// pg parses DATE at local midnight. Using toISOString would move dates back in UTC+ zones.
export function sqlDate(value: string | Date) {
  return value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : String(value).slice(0, 10);
}
const previousDate = (date: string, days: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class AdsService {
  constructor(readonly tenants: TenantsService) {}
  async connections() {
    return (
      await this.tenants.db.query(
        "SELECT id,provider,name,account_id,currency,timezone,enabled,mode,api_version,conversion_metric,status,last_sync_at,next_sync_at,version FROM ad_connections WHERE workspace_id=$1 ORDER BY name",
        [currentTenant().workspaceId],
      )
    ).rows;
  }
  async save(body: any) {
    this.tenants.requireRole("admin");
    const v = adConnectionSchema.parse(body),
      a = currentTenant();
    if (
      v.provider === "google" &&
      !v.credentials.developerToken &&
      v.mode === "live"
    )
      throw new BadRequestException("google_developer_token_required");
    const count = Number(
      (
        await this.tenants.db.query(
          "SELECT count(*) FROM ad_connections WHERE workspace_id=$1",
          [a.workspaceId],
        )
      ).rows[0].count,
    );
    const exists = (
      await this.tenants.db.query(
        "SELECT id FROM ad_connections WHERE workspace_id=$1 AND provider=$2 AND account_id=$3",
        [a.workspaceId, v.provider, v.accountId],
      )
    ).rowCount;
    if (!exists && count >= Number(a.settings.adAccountLimit || 10))
      throw new BadRequestException("ad_account_quota_reached");
    const result = await this.tenants.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        a.workspaceId + ":ad-accounts",
      ]);
      const old = (
        await db.query(
          "SELECT * FROM ad_connections WHERE workspace_id=$1 AND provider=$2 AND account_id=$3 FOR UPDATE",
          [a.workspaceId, v.provider, v.accountId],
        )
      ).rows[0];
      if (old) {
        if (body.expectedVersion !== old.version)
          throw new ConflictException("connection_changed");
        if (old.lease_until && new Date(old.lease_until).getTime() > Date.now())
          throw new ConflictException("sync_in_progress");
        if (
          (old.mode !== v.mode ||
            old.currency !== v.currency ||
            old.timezone !== v.timezone ||
            old.conversion_metric !== v.conversionMetric) &&
          (
            await db.query(
              "SELECT 1 FROM ad_metric_daily WHERE connection_id=$1 LIMIT 1",
              [old.id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "reporting_dimensions_immutable_after_sync",
          );
      }
      return db.query(
        `INSERT INTO ad_connections(id,workspace_id,provider,name,account_id,currency,timezone,enabled,mode,api_version,conversion_metric,credentials)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(workspace_id,provider,account_id) DO UPDATE
      SET name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,enabled=excluded.enabled,mode=excluded.mode,api_version=excluded.api_version,
      conversion_metric=excluded.conversion_metric,credentials=excluded.credentials,status='unverified',version=ad_connections.version+1 RETURNING id`,
        [
          "ad_" + randomUUID(),
          a.workspaceId,
          v.provider,
          v.name,
          v.accountId,
          v.currency,
          v.timezone,
          v.enabled,
          v.mode,
          v.apiVersion,
          v.conversionMetric,
          this.tenants.seal(a.workspaceId, v.credentials),
        ],
      );
    });
    return { id: result.rows[0].id, status: "unverified" };
  }
  async schedule(id: string) {
    this.tenants.requireRole("admin", "marketing");
    const result = await this.tenants.db.query(
      "UPDATE ad_connections SET next_sync_at=now() WHERE workspace_id=$1 AND id=$2 AND enabled RETURNING id",
      [currentTenant().workspaceId, id],
    );
    if (!result.rowCount)
      throw new NotFoundException("enabled_connection_required");
    return { state: "scheduled" };
  }
  async toggle(id: string, enabled: boolean, expectedVersion: number) {
    this.tenants.requireRole("admin");
    const result = await this.tenants.db.query(
      "UPDATE ad_connections SET enabled=$3,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$4 RETURNING id,enabled,version",
      [currentTenant().workspaceId, id, enabled, expectedVersion],
    );
    if (!result.rowCount) throw new ConflictException("connection_changed");
    return result.rows[0];
  }
  async runs() {
    return (
      await this.tenants.db.query(
        "SELECT * FROM ad_sync_runs WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 100",
        [currentTenant().workspaceId],
      )
    ).rows;
  }
  private async request(
    url: string,
    options: RequestInit,
    credentials: any,
    connection: any,
    refresh = true,
  ): Promise<any> {
    const target = new URL(url);
    if (
      !["graph.facebook.com", "googleads.googleapis.com"].includes(
        target.hostname,
      ) ||
      target.protocol !== "https:"
    )
      throw new AdsReadError("provider_origin_rejected");
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new AdsReadError("network_unavailable");
    }
    if (
      response.status === 401 &&
      connection.provider === "google" &&
      refresh &&
      credentials.refreshToken &&
      credentials.clientId &&
      credentials.clientSecret
    ) {
      const refreshed = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      });
      if (!refreshed.ok) throw new AdsReadError("authorization_revoked");
      const data: any = await refreshed.json();
      if (!data.access_token) throw new AdsReadError("authorization_revoked");
      credentials.accessToken = data.access_token;
      await this.tenants.db.query(
        "UPDATE ad_connections SET credentials=$3 WHERE workspace_id=$1 AND id=$2",
        [
          currentTenant().workspaceId,
          connection.id,
          this.tenants.seal(currentTenant().workspaceId, credentials),
        ],
      );
      return this.request(
        url,
        {
          ...options,
          headers: {
            ...options.headers,
            authorization: "Bearer " + credentials.accessToken,
          },
        },
        credentials,
        connection,
        false,
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new AdsReadError("authorization_revoked");
    if (response.status === 429) throw new AdsReadError("rate_limited");
    if (!response.ok)
      throw new AdsReadError("provider_http_" + response.status);
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024)
      throw new AdsReadError("provider_response_too_large");
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AdsReadError("invalid_provider_response");
    }
    if (data.error) throw new AdsReadError("provider_rejected");
    return data;
  }
  private headers(c: any, k: any) {
    return {
      authorization: "Bearer " + k.accessToken,
      ...(c.provider === "google"
        ? {
            "developer-token": k.developerToken,
            ...(k.loginCustomerId
              ? { "login-customer-id": k.loginCustomerId }
              : {}),
          }
        : {}),
      "content-type": "application/json",
    };
  }
  async probe(c: any, k: any) {
    if (c.mode === "mock") return;
    let currency: string, timezone: string;
    if (c.provider === "meta") {
      const data = await this.request(
        `https://graph.facebook.com/${c.api_version}/act_${c.account_id}?fields=currency,timezone_name`,
        { headers: this.headers(c, k) },
        k,
        c,
      );
      currency = data.currency;
      timezone = data.timezone_name;
    } else {
      const data = await this.request(
        `https://googleads.googleapis.com/${c.api_version}/customers/${c.account_id}/googleAds:search`,
        {
          method: "POST",
          headers: this.headers(c, k),
          body: JSON.stringify({
            query:
              "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
          }),
        },
        k,
        c,
      );
      currency = data.results?.[0]?.customer?.currencyCode;
      timezone = data.results?.[0]?.customer?.timeZone;
    }
    if (!currency || !timezone)
      throw new AdsReadError("account_metadata_unavailable");
    if (currency !== c.currency || timezone !== c.timezone)
      throw new AdsReadError("account_currency_or_timezone_mismatch");
  }
  async readDay(c: any, k: any, date: string): Promise<AdMetricRow[]> {
    if (c.mode === "mock")
      return [
        {
          date,
          campaignId: "9001001",
          campaignName: "Fictional B2B acquisition",
          spend: "12.500000",
          impressions: "420",
          clicks: "14",
          platformConversions: "2",
        },
      ];
    const rows: AdMetricRow[] = [],
      seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      let data: any, next: string;
      if (c.provider === "meta") {
        const u = new URL(
          `https://graph.facebook.com/${c.api_version}/act_${c.account_id}/insights`,
        );
        u.search = new URLSearchParams({
          level: "campaign",
          time_increment: "1",
          time_range: JSON.stringify({ since: date, until: date }),
          fields:
            "date_start,campaign_id,campaign_name,spend,impressions,clicks,actions",
          limit: "500",
          ...(cursor ? { after: cursor } : {}),
        }).toString();
        data = await this.request(
          u.toString(),
          { headers: this.headers(c, k) },
          k,
          c,
        );
        if (!Array.isArray(data.data))
          throw new AdsReadError("invalid_provider_response");
        rows.push(
          ...data.data.map((r: any) => metaRow(r, c.conversion_metric)),
        );
        next = data.paging?.next ? data.paging?.cursors?.after : "";
        if (data.paging?.next && !next)
          throw new AdsReadError("pagination_incomplete");
      } else {
        data = await this.request(
          `https://googleads.googleapis.com/${c.api_version}/customers/${c.account_id}/googleAds:search`,
          {
            method: "POST",
            headers: this.headers(c, k),
            body: JSON.stringify({
              query: `SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date = '${date}'`,
              ...(cursor ? { pageToken: cursor } : {}),
            }),
          },
          k,
          c,
        );
        if (data.results !== undefined && !Array.isArray(data.results))
          throw new AdsReadError("invalid_provider_response");
        rows.push(...(data.results || []).map(googleRow));
        next = data.nextPageToken || "";
      }
      if (rows.some((r) => r.date !== date))
        throw new AdsReadError("report_date_mismatch");
      if (!next) return rows;
      if (seen.has(next)) throw new AdsReadError("pagination_loop");
      seen.add(next);
      cursor = next;
    }
    throw new AdsReadError("pagination_limit");
  }
  async processDue() {
    const a = currentTenant();
    const c = (
      await this.tenants.db.query(
        `UPDATE ad_connections SET lease_until=now()+interval '15 minutes' WHERE id=(SELECT id FROM ad_connections
      WHERE workspace_id=$1 AND enabled AND next_sync_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [a.workspaceId],
      )
    ).rows[0];
    if (!c) return null;
    const today = localDate(c.timezone),
      backfill = c.last_backfill_date ? sqlDate(c.last_backfill_date) : null;
    let run: any;
    try {
      run = (
        await this.tenants.db.query(
          "SELECT * FROM ad_sync_runs WHERE workspace_id=$1 AND connection_id=$2 AND state IN ('running','retrying') ORDER BY started_at DESC LIMIT 1",
          [a.workspaceId, c.id],
        )
      ).rows[0];
      if (!run)
        run = (
          await this.tenants.db.query(
            `INSERT INTO ad_sync_runs(id,workspace_id,connection_id,date_from,date_to,state) VALUES($1,$2,$3,$4,$5,'running') RETURNING *`,
            [
              "sync_" + randomUUID(),
              a.workspaceId,
              c.id,
              previousDate(today, backfill === today ? 1 : 29),
              today,
            ],
          )
        ).rows[0];
      await this.tenants.db.query(
        "UPDATE ad_sync_runs SET state='running',error_code=NULL WHERE id=$1",
        [run.id],
      );
      const k = this.tenants.unseal(a.workspaceId, c.credentials);
      await this.probe(c, k);
      const from = sqlDate(run.date_from),
        to = sqlDate(run.date_to),
        done: string[] = run.cursor?.completedDays || [];
      let count = Number(run.row_count || 0);
      for (let day = from; day <= to; day = previousDate(day, -1)) {
        if (done.includes(day)) continue;
        const rows = await this.readDay(c, k, day);
        await this.tenants.transaction(async (db) => {
          const fence = (
            await db.query(
              "SELECT version,enabled FROM ad_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
              [a.workspaceId, c.id],
            )
          ).rows[0];
          if (!fence?.enabled || fence.version !== c.version)
            throw new AdsReadError("connection_changed");
          await db.query(
            "DELETE FROM ad_metric_daily WHERE workspace_id=$1 AND connection_id=$2 AND date=$3",
            [a.workspaceId, c.id, day],
          );
          for (const row of rows)
            await db.query(
              `INSERT INTO ad_metric_daily(workspace_id,connection_id,date,campaign_id,campaign_name,spend,impressions,clicks,platform_conversions,complete,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)`,
              [
                a.workspaceId,
                c.id,
                day,
                row.campaignId,
                row.campaignName,
                row.spend,
                row.impressions,
                row.clicks,
                row.platformConversions,
                run.id,
              ],
            );
          done.push(day);
          count += rows.length;
          await db.query(
            "UPDATE ad_sync_runs SET cursor=$2,row_count=$3 WHERE id=$1",
            [run.id, { completedDays: done }, count],
          );
          await db.query(
            "INSERT INTO ad_sync_days(workspace_id,connection_id,date,run_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,connection_id,date) DO UPDATE SET run_id=excluded.run_id,synced_at=now()",
            [a.workspaceId, c.id, day, run.id],
          );
          await db.query(
            "UPDATE ad_connections SET lease_until=now()+interval '15 minutes' WHERE id=$1",
            [c.id],
          );
        });
      }
      await this.tenants.db.query(
        "UPDATE ad_sync_runs SET state='complete',finished_at=now(),error_code=NULL WHERE id=$1",
        [run.id],
      );
      await this.tenants.db.query(
        "UPDATE ad_connections SET status=$2,last_sync_at=now(),next_sync_at=now()+interval '1 hour',last_backfill_date=$3,lease_until=NULL WHERE id=$1",
        [c.id, c.mode === "mock" ? "mock_verified" : "verified", today],
      );
      return { id: run.id, state: "complete", rows: count, mode: c.mode };
    } catch (error) {
      const code = error instanceof AdsReadError ? error.code : "sync_failed";
      if (run)
        await this.tenants.db.query(
          "UPDATE ad_sync_runs SET state='retrying',error_code=$2 WHERE id=$1",
          [run.id, code],
        );
      await this.tenants.db.query(
        "UPDATE ad_connections SET status=$2,next_sync_at=now()+interval '1 hour',lease_until=NULL WHERE id=$1",
        [c.id, code],
      );
      return { id: run?.id, state: "retrying", error: code };
    }
  }
}
