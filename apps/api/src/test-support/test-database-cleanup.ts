import type { PrismaService } from "../infrastructure/prisma/prisma.service";

/**
 * Removes every plugin installation together with ALL rows that reference one, directly or transitively
 * (conversations, executions, channel connections/messages, approvals, knowledge, skills, …).
 *
 * e2e suites share one test database and run serially, so a suite's hand-maintained `deleteMany()` list
 * goes stale as soon as another suite (or a new schema relation) adds a table that points at `plugins` —
 * e.g. leftover `channel_connections` from the channel suites made `plugin.deleteMany()` violate
 * `channel_connections_plugin_installation_id_fkey`. `TRUNCATE … CASCADE` follows the live FK graph
 * instead. Organizations and users are not referenced by `plugins`, so they are untouched.
 *
 * Refuses to run anywhere but a `*_test` database.
 */
export async function deleteAllPluginData(prisma: PrismaService): Promise<void> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
  if (!row?.name.endsWith("_test")) {
    throw new Error(`deleteAllPluginData refused to run against non-test database "${row?.name ?? "unknown"}"`);
  }
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "plugins" CASCADE');
}
