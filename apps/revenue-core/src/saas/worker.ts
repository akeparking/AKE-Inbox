import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { saasEnabled } from "./context";
import { TenantsService } from "./tenants.service";
import { AdsService } from "./ads.service";
import { FeedbackService } from "./feedback.service";

@Injectable()
export class SaasWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(
    private readonly tenants: TenantsService,
    private readonly ads: AdsService,
    private readonly feedback: FeedbackService,
  ) {}
  onApplicationBootstrap() {
    if (saasEnabled() && process.env.SAAS_WORKER_ENABLED === "true") {
      this.timer = setInterval(() => {
        if (!this.active)
          this.active = this.tick()
            .catch(() => undefined)
            .finally(() => {
              this.active = undefined;
            });
      }, 5000);
      this.timer.unref();
    }
  }
  async tick() {
    await this.tenants.forEachTenant(async () => {
      await this.ads.processDue();
      await this.feedback.reconcile();
    });
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
