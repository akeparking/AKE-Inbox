import { afterEach, describe, expect, it, vi } from "vitest";
import type { RevenueStore } from "./store.types";
import { MemoryRevenueStore } from "./memory.store";
import { PostgresRevenueStore } from "./postgres.store";
import { randomUUID } from "node:crypto";
import { mockQualification } from "../inbox/qualification";
import { ConversionService } from "../conversion/conversion.service";

const drivers = ["memory", ...(process.env.TEST_DATABASE_URL ? ["postgres"] : [])];
describe.each(drivers)("%s workflow invariants", (driver) => {
  let store: RevenueStore;
  afterEach(async () => { await store?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  async function setup() {
    store = driver === "postgres" ? new PostgresRevenueStore(process.env.TEST_DATABASE_URL!) : new MemoryRevenueStore();
    const workspaceId = `test-${randomUUID()}`;
    const input = { workspaceId, provider: "organic" as const, sourceKind: "chat" as const, externalLeadId: "chat:1", displayName: "Fictional buyer", isTest: true, attribution: { provider: "organic" as const, sourceKind: "chat" as const, occurredAt: new Date().toISOString(), identifiers: [] } };
    const lead = await store.ingestLead(input);
    const opportunity = { workspaceId, personId: lead.personId, primarySourceLeadId: lead.id, name: "Demo mall", direction: "ANPR", country: "SA", ownerId: "reviewer", nextAction: "Request drawings", currency: "USD" };
    return { workspaceId, lead, input, opportunity };
  }
  it("deduplicates concurrent intake and opportunity commands without implicit qualification", async () => {
    const { workspaceId, input, opportunity } = await setup();
    await Promise.all(Array.from({ length: 4 }, () => store.ingestLead(input)));
    const results = await Promise.all(Array.from({ length: 4 }, () => store.createOpportunity(opportunity)));
    expect(new Set(results.map((r) => r.opportunity.id)).size).toBe(1);
    expect(await store.listLeads(workspaceId)).toHaveLength(1);
    expect(await store.listDeliveries(workspaceId)).toHaveLength(0);
    expect((await store.listLeads(workspaceId))[0].status).toBe("new");
  });
  it("requires human qualification and emits one Mock event without inventing ad IDs", async () => {
    const { workspaceId, opportunity } = await setup();
    const created = await store.createOpportunity(opportunity);
    const input = { workspaceId, opportunityId: created.opportunity.id, actorId: "human-reviewer", contactReachable: true as const, relevantNeed: true as const, targetBuyer: true as const, nextAction: "Request site drawings" };
    await expect(store.qualifyOpportunity({ ...input, contactReachable: false as any })).rejects.toThrow();
    const results = await Promise.all(Array.from({ length: 4 }, () => store.qualifyOpportunity(input)));
    expect(new Set(results.map((r) => r.delivery.eventId)).size).toBe(1);
    expect(await store.listDeliveries(workspaceId)).toHaveLength(1);
    expect(results[0].delivery).toMatchObject({ mode: "mock", status: "pending" });
    expect((await store.listLeads(workspaceId))[0].attribution.identifiers).toEqual([]);
    expect((await store.listAudit(workspaceId)).some((e) => e.action === "lead.qualified")).toBe(true);
  });
  it("rejects stale stage writes and cross-workspace access", async () => {
    const { workspaceId, opportunity } = await setup();
    const created = await store.createOpportunity(opportunity);
    const input = { workspaceId, opportunityId: created.opportunity.id, actorId: "reviewer", stage: "solution_fit" as const, expectedVersion: 0 };
    expect((await store.updateOpportunityStage(input)).stage).toBe("solution_fit");
    await expect(store.updateOpportunityStage({ ...input, stage: "quotation" })).rejects.toThrow(/Refresh/);
    await expect(store.updateOpportunityStage({ ...input, workspaceId: "wrong" })).rejects.toThrow();
    expect(await store.listDeliveries(workspaceId)).toHaveLength(0);
  });
  it("saves analysis to the Lead while retaining human edits and explicit zero", async () => {
    const { workspaceId, lead } = await setup();
    const message = "We are in Manila exploring ANPR with 0 parking spaces confirmed.";
    const input = { workspaceId, leadId: lead.id, eventId: "message-1", conversationId: "chat:1", channel: "website" as const, displayName: "Fictional buyer", isTest: true, occurredAt: new Date().toISOString(), message };
    const first = await store.saveInquiry(input);
    expect((await store.saveInquiry(input)).id).toBe(first.id);
    await expect(store.saveInquiry({ ...input, message: "Changed content" })).rejects.toThrow();
    const analysis = mockQualification(message);
    await store.completeInquiry(workspaceId, first.id, { analysis, provider: "mock" });
    await store.applyQualification(workspaceId, lead.id, "reviewer", { ...analysis, country: "Philippines" }, 0);
    const second = await store.saveInquiry({ ...input, eventId: "message-2", message: "New message" });
    await store.completeInquiry(workspaceId, second.id, { analysis: { ...analysis, country: null }, provider: "mock" });
    const saved = (await store.listLeads(workspaceId))[0];
    expect(saved.aiQualification?.country).toBeNull();
    expect(saved.confirmedQualification?.country).toBe("Philippines");
    expect(saved.confirmedQualification?.parkingSpaces).toBe(0);
    await expect(store.applyQualification(workspaceId, lead.id, "reviewer", analysis, 0)).rejects.toThrow();
  });
  it("blocks live events for fictional fixtures", async () => {
    const { workspaceId, opportunity } = await setup();
    vi.stubEnv("ADS_MODE", "live");
    const created = await store.createOpportunity(opportunity);
    const result = await store.qualifyOpportunity({ workspaceId, opportunityId: created.opportunity.id, actorId: "reviewer", contactReachable: true, relevantNeed: true, targetBuyer: true, nextAction: "Request drawings" });
    expect(result.delivery).toMatchObject({ status: "skipped", skippedReason: "test_record" });
  });
  it("Mock rollback leaves persisted live events untouched and makes no platform requests", async () => {
    const { workspaceId, lead } = await setup();
    vi.stubEnv('QUALIFIED_FEEDBACK_ENABLED', 'true');
    vi.stubEnv('ADS_MODE', 'live');
    // Fully fictional record marked non-test only to exercise a persisted live outbox.
    // Transport is forbidden throughout this isolated test.
    const liveLead = await store.ingestLead({ workspaceId, provider:'google', sourceKind:'website',
      externalLeadId:'fictional-mode-boundary', displayName:'Fictional queue recovery', isTest:false,
      attribution:{provider:'google',sourceKind:'website',occurredAt:new Date().toISOString(),consentStatus:'granted',
        identifiers:[{type:'google_gclid',value:'fictional-never-upload'}]} });
    const checks={workspaceId,actorId:'fixture-reviewer',contactReachable:true,relevantNeed:true,targetBuyer:true,nextAction:'Local recovery test'};
    const live = await store.qualifyLead({...checks,leadId:liveLead.id});
    expect(live.delivery).toMatchObject({mode:'live',status:'pending'});
    vi.stubEnv('ADS_MODE','mock');
    const mock = await store.qualifyLead({...checks,leadId:lead.id});
    const transport=vi.fn(async()=>{throw Error('External transport forbidden');});vi.stubGlobal('fetch',transport);
    const service=new ConversionService(store);
    await service.processBatch(1000);
    const deliveries=await store.listDeliveries(workspaceId);
    expect(deliveries.find(d=>d.id===live.delivery.id)).toMatchObject({status:'pending',attemptCount:0});
    expect(deliveries.find(d=>d.id===mock.delivery.id)).toMatchObject({status:'accepted',mode:'mock'});
    await store.updateDelivery(live.delivery.id,{status:'accepted',providerResponseId:'fictional-request',receiptStages:{validation:'passed',acceptance:'accepted',processing:'unknown',matching:'unknown'}});
    vi.stubEnv('DEFAULT_WORKSPACE_ID',workspaceId);
    await new ConversionService(store).processBatch(1000);
    expect(transport).not.toHaveBeenCalled();
  });
  it("the feedback off switch preserves pending work until explicitly re-enabled", async () => {
    const {workspaceId,lead}=await setup();vi.stubEnv('ADS_MODE','mock');
    const r=await store.qualifyLead({workspaceId,leadId:lead.id,actorId:'reviewer',contactReachable:true,relevantNeed:true,targetBuyer:true,nextAction:'Local feature-off test'});
    vi.stubEnv('QUALIFIED_FEEDBACK_ENABLED','false');
    expect(await new ConversionService(store).processBatch(1000)).toEqual([]);
    expect((await store.listDeliveries(workspaceId)).find(d=>d.id===r.delivery.id)).toMatchObject({status:'pending',attemptCount:0});
    vi.stubEnv('QUALIFIED_FEEDBACK_ENABLED','true');await new ConversionService(store).processBatch(1000);
    expect((await store.listDeliveries(workspaceId)).find(d=>d.id===r.delivery.id)).toMatchObject({status:'accepted',attemptCount:1});
  });
});
