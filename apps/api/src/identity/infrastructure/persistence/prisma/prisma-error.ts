import { Prisma } from "@prisma/client";
import { PersistenceConflictError } from "../../../application/ports/persistence-error";

export function translateKnownPrismaError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const target = Array.isArray(error.meta?.target)
      ? error.meta.target.map(String).join(",")
      : "unknown";
    throw new PersistenceConflictError(target);
  }
  throw error;
}
