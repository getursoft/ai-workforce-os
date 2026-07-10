import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class SecurityEventLogger {
  private readonly logger = new Logger("IdentitySecurity");

  success(
    event: string,
    requestId: string,
    identity: { userId?: string; organizationId?: string; sessionId?: string } = {}
  ): void {
    this.logger.log(
      JSON.stringify({ event, requestId, ...identity, timestamp: new Date().toISOString() })
    );
  }

  failure(event: string, requestId: string, failureCategory: string): void {
    this.logger.warn(
      JSON.stringify({ event, requestId, failureCategory, timestamp: new Date().toISOString() })
    );
  }
}
