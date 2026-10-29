import { NextRequest, NextResponse } from "next/server";

// Public integration ingress. The Core verifies HMACs or the native-message
// token and performs its own tenant lookup. Browser session headers never pass.
export async function ingress(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  if (process.env.SAAS_MODE !== "true")
    return new NextResponse(null, { status: 404 });
  const path = (await context.params).path.join("/");
  const valid = /^(intake|meta-leads)\/[a-z0-9][a-z0-9-]{1,62}$/.test(path) ||
    /^chatwoot\/[a-z0-9][a-z0-9-]{1,62}\/[a-f0-9]{64}$/.test(path);
  if (!valid || (request.method === "GET" && !path.startsWith("meta-leads/")))
    return new NextResponse(null, { status: 404 });
  const body = request.method === "GET" ? undefined : await request.text();
  if (body && Buffer.byteLength(body) > 128 * 1024)
    return new NextResponse(null, { status: 413 });
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const name of ["x-intake-timestamp", "x-intake-signature", "x-hub-signature-256"])
    if (request.headers.has(name)) headers[name] = request.headers.get(name)!;
  try {
    const result = await fetch(
      (process.env.SERVER_API_URL || "http://127.0.0.1:4100") +
        "/api/v1/saas/" + path + request.nextUrl.search,
      { method: request.method, headers, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60000) },
    );
    return new NextResponse(result.body, { status: result.status, headers: {
      "content-type": result.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    } });
  } catch {
    // An unavailable upstream is not a receipt. Providers may retry the same ID.
    return NextResponse.json({ error: "intake_temporarily_unavailable" }, { status: 503 });
  }
}
export const GET = ingress;
export const POST = ingress;
