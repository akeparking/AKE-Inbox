import { NextResponse, type NextRequest } from "next/server";
import { validSession, SESSION_COOKIE } from "./lib/auth";

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if(process.env.SAAS_MODE==='true'){
    if(path==='/'||path==='/inbox'||path==='/workspace')return NextResponse.redirect(new URL(`${process.env.NEXT_PUBLIC_BASE_PATH||''}/saas`,request.url));
    if(path==='/saas'||path.startsWith('/api/saas/')||path.startsWith('/api/saas-hooks/')||path.startsWith('/_next/')||path==='/icon.svg')return NextResponse.next();
    return NextResponse.json({message:'请使用组织工作台入口'},{status:404});
  }
  if (path === "/inbox" || path.startsWith("/api/inbox/") || path === "/" || path === "/login" || path === "/api/session" || path.startsWith("/_next/") || path === "/icon.svg" || path.startsWith("/showcase/")) return NextResponse.next();
  if (validSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (path.startsWith("/api/")) return NextResponse.json({ message: "Sign in to the demo workspace." }, { status: 401 });
  return NextResponse.redirect(new URL(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/login`, request.url));
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
