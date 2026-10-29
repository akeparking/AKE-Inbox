import { ServiceUnavailableException } from "@nestjs/common";

/** Server-owned origins and no redirects keep tenant credentials on the selected provider. */
export async function generateSuggestion(config: any, system: string, input: unknown) {
  const base = new URL(config.baseUrl || "https://api.openai.com/v1");
  const allowed = (process.env.SAAS_MODEL_ORIGINS || "https://api.openai.com").split(",");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
      !allowed.includes(base.origin) || !config.apiKey || !config.model ||
      !["openai-compatible", "anthropic-compatible"].includes(config.provider))
    throw new ServiceUnavailableException("model_not_configured");
  const anthropic = config.provider === "anthropic-compatible";
  const payload: any = {
    model: config.model, max_tokens: 2500, stream: false,
    messages: [{ role: "user", content: JSON.stringify(input) }],
  };
  if (anthropic) {
    payload.system = system;
    if (config.disableThinking === true) payload.thinking = { type: "disabled" };
  } else payload.messages.unshift({ role: "system", content: system });
  let response: Response;
  try {
    response = await fetch(base.toString().replace(/\/$/, "") + (anthropic ? "/messages" : "/chat/completions"), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(55000),
      headers: {
        "content-type": "application/json",
        ...(anthropic ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" } :
          { authorization: "Bearer " + config.apiKey }),
      },
      body: JSON.stringify(payload),
    });
  } catch { throw new ServiceUnavailableException("model_unavailable"); }
  if (!response.ok) throw new ServiceUnavailableException(
    response.status === 401 || response.status === 403 ? "model_authorization_required" :
      response.status === 429 ? "model_rate_limited" : "model_request_failed",
  );
  let data: any;
  try {
    const raw = await response.text();
    if (raw.length > 1048576) throw new Error();
    data = JSON.parse(raw);
  } catch { throw new ServiceUnavailableException("invalid_model_response"); }
  let text: unknown;
  if (anthropic) {
    if (data.stop_reason !== "end_turn" || !Array.isArray(data.content) ||
        data.content.some((b: any) => !["text", "thinking", "redacted_thinking"].includes(b.type)))
      throw new ServiceUnavailableException("incomplete_model_output");
    text = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  } else {
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== "stop" || choice.message?.tool_calls || choice.message?.function_call)
      throw new ServiceUnavailableException("incomplete_model_output");
    text = choice.message?.content;
  }
  if (typeof text !== "string" || !text.trim() || text.length > 24000)
    throw new ServiceUnavailableException("invalid_model_output");
  if (/-----BEGIN|Bearer\s+|sk-[A-Za-z0-9]{12}|access_token|refresh_token|api_access_token/i.test(text))
    throw new ServiceUnavailableException("model_output_rejected");
  return { text, model: /^[A-Za-z0-9_./:+-]{1,128}$/.test(data.model || "") ? data.model : null };
}
