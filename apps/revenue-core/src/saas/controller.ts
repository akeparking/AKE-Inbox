import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  ParseIntPipe,
  UseFilters,
} from "@nestjs/common";
import { z } from "zod";
import { tenantRoles } from "@ake/contracts";
import { currentTenant } from "./context";
import { TenantsService } from "./tenants.service";
import { SaasCrmService } from "./crm.service";
import { IntakeService } from "./intake.service";
import { ConversationsService } from "./conversations.service";
import { AdsService } from "./ads.service";
import { ReportsService } from "./reports.service";
import { SaasAiService } from "./ai.service";
import { SaasExceptionFilter } from "./errors";
import { FeedbackService } from "./feedback.service";
import { SaasSettingsService } from "./settings.service";
import { MetaLeadsService } from "./meta-leads.service";

@Controller("api/v1/saas")
@UseFilters(SaasExceptionFilter)
export class SaasController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly crm: SaasCrmService,
    private readonly intake: IntakeService,
    private readonly conversations: ConversationsService,
    private readonly ads: AdsService,
    private readonly reports: ReportsService,
    private readonly ai: SaasAiService,
    private readonly feedback: FeedbackService,
    private readonly settings: SaasSettingsService,
    private readonly metaLeads: MetaLeadsService,
  ) {}
  @Post("session") login(@Body() body: unknown) {
    return this.tenants.login(body);
  }
  @Get("session") session() {
    const a = currentTenant();
    return {
      slug: a.slug,
      name: a.name,
      userId: a.userId,
      role: a.role,
      accountId: a.accountId,
      effectiveFrom: a.effectiveFrom,
      settings: a.settings,
    };
  }
  @Post("logout") logout() {
    return this.tenants.logout();
  }
  @Post("intake/:slug") receive(@Param("slug") slug: string, @Req() req: any) {
    return this.intake.webhook(
      slug,
      req.body,
      req.rawBody,
      String(req.headers["x-intake-timestamp"] || ""),
      String(req.headers["x-intake-signature"] || ""),
    );
  }
  @Post("chatwoot/:slug/:token") webhook(
    @Param("slug") slug: string,
    @Param("token") token: string,
    @Body() body: any,
  ) {
    return this.conversations.webhook(slug, token, body);
  }
  @Get("records/:resource") list(
    @Param("resource") r: string,
    @Query("q") q: string,
    @Query("page") page: string,
  ) {
    return this.crm.list(r, q, Number(page));
  }
  @Get("export/:resource") export(@Param("resource") r: string) {
    return this.crm.export(r);
  }
  @Get("leads/:id") detail(@Param("id") id: string) {
    return this.crm.detail(id);
  }
  @Post("leads/:id/link") link(@Param("id") id: string, @Body() body: any) {
    return this.crm.link(id, body);
  }
  @Post("leads/:id/qualify") qualify(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.crm.qualify(id, body);
  }
  @Post("leads/:id/ai") suggest(@Param("id") id: string, @Body() body: any) {
    return this.ai.suggest(id, body);
  }
  @Post("companies") company(@Body() body: any) {
    return this.crm.company(body);
  }
  @Get("companies/:id") customer(@Param("id") id: string) {
    return this.crm.customer(id);
  }
  @Post("companies/:id") companyUpdate(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.crm.company(body, id);
  }
  @Post("people") person(@Body() body: any) {
    return this.crm.person(body);
  }
  @Post("people/:id") personUpdate(@Param("id") id: string, @Body() body: any) {
    return this.crm.person(body, id);
  }
  @Post("opportunities") opportunity(@Body() body: any) {
    return this.crm.createOpportunity(body);
  }
  @Post("opportunities/:id") opportunityUpdate(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.crm.opportunity(id, body);
  }
  @Post("opportunities/:id/stage") stage(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.crm.stage(id, body);
  }
  @Post("opportunities/:id/outcome") outcome(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.crm.outcome(id, body);
  }
  @Post("tasks") task(@Body() body: any) {
    return this.crm.task(body);
  }
  @Post("tasks/:id") taskUpdate(@Param("id") id: string, @Body() body: any) {
    return this.crm.task(body, id);
  }
  @Post("notes") note(@Body() body: any) {
    return this.crm.note(body);
  }
  @Post("quotes") quote(@Body() body: any) {
    return this.crm.quote(body);
  }
  @Get("pipeline") pipeline() {
    return this.crm.pipeline();
  }
  @Post("pipeline") pipelineUpdate(@Body() body: any) {
    return this.crm.pipeline(body);
  }
  @Post("knowledge") knowledge(@Body() body: any) {
    return this.crm.knowledge(body);
  }
  @Post("knowledge/:id") knowledgeUpdate(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    return this.crm.knowledge(body, id);
  }
  @Get("members") members() {
    return this.tenants.members();
  }
  @Post("invitations") invite(@Body() body: any) {
    const v = z
      .object({ userId: z.string().regex(/^\d+$/), role: z.enum(tenantRoles) })
      .parse(body);
    return this.tenants.invite(v.userId, v.role);
  }
  @Post("members/:id") member(@Param("id") id: string, @Body() body: any) {
    const v = z
      .object({ role: z.enum(tenantRoles), active: z.boolean() })
      .parse(body);
    return this.tenants.updateMember(id, v.role, v.active);
  }
  @Get("channels") channels() {
    return this.conversations.channels();
  }
  @Post("channels") enroll(@Body() body: any) {
    return this.conversations.enroll(body);
  }
  @Get("conversations") inbox(@Query("page") page: string) {
    return this.conversations.list(Number(page) || 1);
  }
  @Get("conversations/:id/messages") messages(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.conversations.messages(id);
  }
  @Post("conversations/:id/messages") send(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.conversations.send(id, body);
  }
  @Post("conversations/:id/takeover") takeover(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.conversations.takeOver(id);
  }
  @Get("ad-connections") connections() {
    return this.ads.connections();
  }
  @Post("ad-connections") connection(@Body() body: any) {
    return this.ads.save(body);
  }
  @Post("ad-connections/:id/sync") sync(@Param("id") id: string) {
    return this.ads.schedule(id);
  }
  @Post("ad-connections/:id/toggle") toggle(
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const v = z
      .object({
        enabled: z.boolean(),
        expectedVersion: z.number().int().nonnegative(),
      })
      .parse(body);
    return this.ads.toggle(id, v.enabled, v.expectedVersion);
  }
  @Get("sync-runs") runs() {
    return this.ads.runs();
  }
  @Get("reports") report(@Query() query: any) {
    return this.reports.report(query);
  }
  @Get("health") health() {
    return this.tenants.status();
  }
  @Get("integrations") integrationStatus() {
    return this.settings.status();
  }
  @Post("integrations/:kind") integrationSave(
    @Param("kind") kind: string,
    @Body() body: unknown,
  ) {
    return this.settings.save(kind, body);
  }
  @Get("meta-leads/:slug") metaChallenge(
    @Param("slug") slug: string,
    @Query() query: any,
  ) {
    return this.metaLeads.challenge(slug, query);
  }
  @Post("meta-leads/:slug") metaReceive(
    @Param("slug") slug: string,
    @Req() req: any,
  ) {
    return this.metaLeads.receive(
      slug,
      req.body,
      req.rawBody,
      String(req.headers["x-hub-signature-256"] || ""),
    );
  }
  @Get("feedback") feedbackList() {
    return this.feedback.list();
  }
  @Post("feedback/:kind/:id/send") feedbackSend(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.feedback.send(kind, id, body);
  }
  @Post("feedback/:kind/:id/retry") feedbackRetry(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.feedback.rearmRejected(kind, id, body);
  }
}
