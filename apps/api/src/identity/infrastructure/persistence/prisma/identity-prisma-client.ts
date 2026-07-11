import type { Prisma } from "@prisma/client";

export type IdentityPrismaClient = Pick<
  Prisma.TransactionClient,
  "organization" | "organizationSetting" | "user" | "authenticationSession"
>;
