import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSuggestion } from "./ai-provider";
import { refreshGoogleToken } from "./google-oauth";
import { MetaAdsAdapter } from "../conversion/adapters";
import { loadConfig } from "../config";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("live provider contracts (HTTP fixtures)", () => {
  const model = { provider: "anthropic-compatible", baseUrl: "https://api.example.test/v1", model: "fixture", apiKey: "private-fixture", disableThinking: true };
  it("uses the Anthropic protocol and rejects incomplete or tool-directed responses", async () => {
    vi.stubEnv("SAAS_MODEL_ORIGINS", "https://api.example.test");
    const request = vi.fn(async () => new Response(JSON.stringify({ model: "fixture-1", stop_reason: "end_turn", content: [{ type: "text", text: "A draft" }] })));
    vi.stubGlobal("fetch", request);
    expect(await generateSuggestion(model, "Trusted instruction", { message: "untrusted" })).toEqual({ text: "A draft", model: "fixture-1" });
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/messages");
    expect(options.headers).toMatchObject({ "x-api-key": "private-fixture", "anthropic-version": "2023-06-01" });
    expect(options.redirect).toBe("error");
    expect(JSON.parse(String(options.body))).toMatchObject({ system: "Trusted instruction", thinking: { type: "disabled" }, stream: false });
    request.mockImplementation(async () => new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: "incomplete" }] })));
    await expect(generateSuggestion(model, "", {})).rejects.toThrow("incomplete_model_output");
    request.mockImplementation(async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "tool_use", name: "write_crm" }] })));
    await expect(generateSuggestion(model, "", {})).rejects.toThrow("incomplete_model_output");
  });
  it("retains OpenAI compatibility and prevents secret disclosure and credential redirects", async () => {
    vi.stubEnv("SAAS_MODEL_ORIGINS", "https://api.example.test");
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Draft only" } }] })));
    vi.stubGlobal("fetch", request);
    expect((await generateSuggestion({ ...model, provider: "openai-compatible" }, "", {})).text).toBe("Draft only");
    await expect(generateSuggestion({ ...model, baseUrl: "https://other.example.test" }, "", {})).rejects.toThrow("model_not_configured");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValue(new Error("Bearer private-fixture"));
    await expect(generateSuggestion(model, "", {})).rejects.toThrow("model_unavailable");
  });
  it("refreshes Google OAuth credentials with expiry and safe errors", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 })));
    vi.stubGlobal("fetch", request);
    const old = { accessToken: "old", refreshToken: "refresh", clientId: "client", clientSecret: "secret" };
    const refreshed = await refreshGoogleToken(old);
    expect(refreshed.accessToken).toBe("new");
    expect(refreshed.refreshToken).toBe("refresh");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 3500000);
    expect(old.accessToken).toBe("old");
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(options.redirect).toBe("error");
    expect(String(options.body)).toContain("grant_type=refresh_token");
    request.mockImplementation(async () => new Response('{"error_description":"private secret"}', { status: 400 }));
    await expect(refreshGoogleToken(old)).rejects.toThrow("authorization_revoked");
  });
  it("keeps native Meta CRM stages distinct from website CAPI", () => {
    const adapter = new MetaAdsAdapter(loadConfig());
    const context: any = { lead: { id: "fictional", sourceKind: "instant_form" }, delivery: { occurredAt: new Date().toISOString(), eventId: "stable-stage" }, identifiers: [{ type: "meta_leadgen_id", value: "1234567890123456" }] };
    const native: any = adapter.buildQualifiedPayload(context);
    expect(native.data[0]).toMatchObject({ action_source: "system_generated", event_id: "stable-stage", user_data: { lead_id: "1234567890123456" }, custom_data: { event_source: "crm" } });
    context.identifiers = [];
    expect(() => adapter.buildQualifiedPayload(context)).toThrow("Native form lead ID required");
    context.lead.sourceKind = "website";
    const website: any = adapter.buildQualifiedPayload(context);
    expect(website.data[0].action_source).toBe("other");
    expect(website.data[0].custom_data.event_source).toBeUndefined();
    expect(website.data[0].user_data.lead_id).toBeUndefined();
  });
});
