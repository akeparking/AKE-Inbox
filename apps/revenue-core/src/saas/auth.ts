import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  NestInterceptor,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { saasEnabled, tenantContext } from "./context";
import { TenantsService } from "./tenants.service";

@Injectable()
export class SaasGuard implements CanActivate {
  constructor(private readonly tenants: TenantsService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest(),
      path = req.path || req.url.split("?")[0];
    if (!saasEnabled()) {
      if (path.startsWith("/api/v1/saas")) throw new NotFoundException();
      return true;
    }
    if (path === "/health") return true;
    if (
      ["GET", "POST"].includes(req.method) &&
      /^\/api\/v1\/saas\/meta-leads\/[a-z0-9-]+$/.test(path)
    )
      return true;
    if (
      req.method === "POST" &&
      (path === "/api/v1/saas/session" ||
        /^\/api\/v1\/saas\/intake\/[a-z0-9-]+$/.test(path) ||
        /^\/api\/v1\/saas\/chatwoot\/[a-z0-9-]+\/[a-f0-9]{64}$/.test(path))
    )
      return true;
    // Legacy routes retain their contract in office mode. SaaS has its own verified-session routes.
    if (!path.startsWith("/api/v1/saas/"))
      throw new ForbiddenException("route_not_available_in_saas");
    const actor = await this.tenants.authenticate(
      String(req.headers["x-saas-session"] || ""),
    );
    req.tenant = actor;
    if (req.method !== "GET" && path !== "/api/v1/saas/logout") {
      if (actor.role === "viewer")
        throw new ForbiddenException("read_only_role");
      if (
        !path.startsWith("/api/v1/saas") &&
        !["sales", "admin"].includes(actor.role)
      )
        throw new ForbiddenException("sales_role_required");
      if (req.body?.ownerId)
        await tenantContext.run(actor, () =>
          this.tenants.requireOwner(String(req.body.ownerId)),
        );
      if (path.endsWith("/stage") && ["won", "lost"].includes(req.body?.stage))
        throw new ForbiddenException("use_reviewed_outcome");
    }
    return true;
  }
}
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const actor = context.switchToHttp().getRequest().tenant;
    if (!actor) return next.handle();
    return new Observable((subscriber) =>
      tenantContext.run(actor, () => next.handle().subscribe(subscriber)),
    );
  }
}
