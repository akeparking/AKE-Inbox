import { NextRequest, NextResponse } from "next/server";
import { allowedWorkspaceOrigin } from "../../../../lib/workspace-origin";

const cookie = "ake_saas_session";
export async function proxySaas(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  if (process.env.SAAS_MODE !== "true")
    return NextResponse.json({ message: "未启用组织工作台" }, { status: 404 });
  const segments = (await ctx.params).path;
  if (segments.some((s) => !/^[a-zA-Z0-9_-]+$/.test(s)))
    return NextResponse.json({ message: "请求无效" }, { status: 400 });
  const path = segments.join("/");
  // Webhooks are server integrations and can never be proxied from a browser session.
  if (["intake", "chatwoot", "meta-leads"].includes(segments[0]))
    return NextResponse.json({ message: "接口不可用" }, { status: 404 });
  if (
    req.method !== "GET" &&
    !allowedWorkspaceOrigin(req.headers.get("origin"), req.nextUrl.origin)
  )
    return NextResponse.json(
      { message: "请从当前工作台提交" },
      { status: 403 },
    );
  const token = req.cookies.get(cookie)?.value;
  if (!(path === "session" && req.method === "POST") && !token)
    return NextResponse.json(
      { message: "请先登录组织工作台" },
      { status: 401 },
    );
  try {
    const body = req.method === "GET" ? undefined : await req.text();
    if (body && body.length > 128 * 1024)
      return NextResponse.json({ message: "提交内容过大" }, { status: 413 });
    const result = await fetch(
      (process.env.SERVER_API_URL || "http://127.0.0.1:4100") +
        "/api/v1/saas/" +
        path +
        req.nextUrl.search,
      {
        method: req.method,
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-saas-session": token } : {}),
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      },
    );
    if (path === "session" && req.method === "POST" && result.ok) {
      const data = await result.json();
      const { token: session, ...actor } = data;
      const response = NextResponse.json(actor, {
        headers: { "cache-control": "no-store" },
      });
      response.cookies.set(cookie, session, {
        httpOnly: true,
        secure: (
          process.env.WORKSPACE_PUBLIC_ORIGIN || req.nextUrl.origin
        ).startsWith("https:"),
        sameSite: "strict",
        path: (process.env.NEXT_PUBLIC_BASE_PATH || "") + "/",
        maxAge: 8 * 3600,
      });
      return response;
    }
    const response = new NextResponse(result.body, {
      status: result.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
    if (path === "logout" || result.status === 401)
      response.cookies.set(cookie, "", {
        path: (process.env.NEXT_PUBLIC_BASE_PATH || "") + "/",
        maxAge: 0,
      });
    return response;
  } catch {
    return NextResponse.json(
      { message: "连接暂时中断。请保留当前内容后重试。" },
      { status: 502 },
    );
  }
}
export const GET = proxySaas;
export const POST = proxySaas;
