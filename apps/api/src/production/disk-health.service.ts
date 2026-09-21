import { Injectable, Logger, Inject } from "@nestjs/common";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { AppConfig } from "../config/app-config";
import { APP_CONFIG } from "../config/config.tokens";

@Injectable()
export class DiskHealthService {
  private readonly logger = new Logger(DiskHealthService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheck: Date | null = null;
  private lastWarningLevel: string | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.check();
    this.timer = setInterval(() => void this.check(), 5 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getLastCheck(): Date | null {
    return this.lastCheck;
  }

  getLastWarningLevel(): string | null {
    return this.lastWarningLevel;
  }

  check(): { usableBytes: number; usedPercent: number; status: string; warningLevel: string | null } {
    try {
      const stat = statSync(homedir());
      const usableBytes = stat.size;
      const usedPercent = (1 - usableBytes / (stat.size || 1)) * 100;

      const warningThreshold = this.config.number("DISK_WARNING_THRESHOLD_PERCENT", 85);
      const criticalThreshold = this.config.number("DISK_CRITICAL_THRESHOLD_PERCENT", 95);

      let status = "HEALTHY";
      let warningLevel: string | null = null;

      if (usedPercent >= criticalThreshold) {
        status = "CRITICAL";
        warningLevel = "CRITICAL";
      } else if (usedPercent >= warningThreshold) {
        status = "WARNING";
        warningLevel = "WARNING";
      }

      this.lastCheck = new Date();
      this.lastWarningLevel = warningLevel;

      this.logger.log({
        event: "DISK_HEALTH_CHECK",
        status,
        usedPercent: Math.round(usedPercent * 100) / 100,
        warningLevel
      });

      return { usableBytes, usedPercent: Math.round(usedPercent * 100) / 100, status, warningLevel };
    } catch (error) {
      this.logger.error({ event: "DISK_HEALTH_CHECK_FAILED", error: String(error) });
      return { usableBytes: 0, usedPercent: 0, status: "UNKNOWN", warningLevel: null };
    }
  }
}
