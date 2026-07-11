import { Injectable } from "@nestjs/common";
import type {
  IdentityRepositories,
  IdentityUnitOfWork
} from "../../../application/ports/identity-unit-of-work";
import { PrismaService } from "../../../../infrastructure/prisma/prisma.service";
import { PrismaAuthenticationSessionRepository } from "./repositories/prisma-authentication-session.repository";
import { PrismaOrganizationRepository } from "./repositories/prisma-organization.repository";
import { PrismaOrganizationSettingRepository } from "./repositories/prisma-organization-setting.repository";
import { PrismaUserRepository } from "./repositories/prisma-user.repository";

@Injectable()
export class PrismaIdentityUnitOfWork implements IdentityUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  execute<T>(callback: (repositories: IdentityRepositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (transaction) =>
      callback({
        organizations: new PrismaOrganizationRepository(transaction),
        organizationSettings: new PrismaOrganizationSettingRepository(transaction),
        users: new PrismaUserRepository(transaction),
        sessions: new PrismaAuthenticationSessionRepository(transaction)
      })
    );
  }
}
