import type { AuthenticationSessionRepository } from "../ports/authentication-session-repository";
import type { Clock } from "../ports/clock";
import type { IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { RefreshTokenService } from "../ports/refresh-token-service";

export interface LogoutCommand {
  refreshToken: string;
}

export interface LogoutResult {
  success: true;
}

export const LOGOUT = Symbol("Logout");

export class LogoutHandler {
  constructor(
    private readonly sessions: AuthenticationSessionRepository,
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly refreshTokens: RefreshTokenService,
    private readonly clock: Clock
  ) {}

  async execute(command: LogoutCommand): Promise<LogoutResult> {
    try {
      const parsed = this.refreshTokens.parse(command.refreshToken);
      const session = await this.sessions.findById(parsed.sessionId);
      if (
        session &&
        !session.isRevoked() &&
        this.refreshTokens.verifyHash(command.refreshToken, session.tokenHashForPersistence())
      ) {
        await this.unitOfWork.execute(async (repositories) => {
          await repositories.sessions.revoke(session.id, this.clock.now(), null);
        });
      }
    } catch {
      // Logout intentionally conceals token and session validity.
    }
    return { success: true };
  }
}
