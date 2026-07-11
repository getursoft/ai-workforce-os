import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class AuditEventLogger {
  private readonly logger = new Logger("IdentityAudit");

  record(
    event: string,
    requestId: string,
    identity: { organizationId?: string } = {}
  ): void {
    this.logger.log(
      JSON.stringify({ event, requestId, ...identity, timestamp: new Date().toISOString() })
    );
  }
}
