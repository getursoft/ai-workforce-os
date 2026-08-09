# Runbook: Database Unavailable

## Symptoms
- `GET /health/ready` returns non-200.
- API logs show `DATABASE_CONNECT_RETRY` / `DATABASE_CONNECT_FAILED` (see `PrismaService`, Sprint 5.0
  Phase 5 — it retries up to 5 times with backoff before failing loudly).
- Requests time out or 5xx across the board.

## Immediate checks
1. Is the database process/instance actually up? (Managed provider status page, or `docker compose ps` /
   `pg_isready` for local/self-hosted.)
2. Connection pool exhaustion: check `DATABASE_POOL_MAX` vs. actual connected clients
   (`SELECT count(*) FROM pg_stat_activity`). If every API replica is maxed out, either the pool is too
   small for replica count × `DATABASE_POOL_MAX`, or a query is holding connections open too long —
   check for `SLOW_QUERY` log lines (Phase 5 logs any query over `DATABASE_SLOW_QUERY_MS`, default 500ms).
3. Network/security group: can the API reach the DB host on 5432? (Common cause after infra changes.)
4. Statement timeout hits: `DATABASE_STATEMENT_TIMEOUT_MS` (default 30s) should prevent one query from
   wedging a connection forever — if you're seeing wedged connections anyway, that config may not be
   reaching the effective connection (check the connection string's `statement_timeout` query param).

## Mitigation
- If it's provider-side: follow the provider's status/support process; there's nothing to fix in this
  codebase.
- If it's pool exhaustion: increase `DATABASE_POOL_MAX` (bounded by the provider's own max connections —
  don't just raise this repo's config past what the DB server allows) or reduce replica count temporarily.
- If a specific query is the cause: it will be in the `SLOW_QUERY` logs with the query text (truncated to
  400 chars) and duration — that's enough to identify it without needing `pg_stat_statements`.

## After recovery
- Confirm `/health/ready` is green across all replicas, not just one.
- Check `ObservabilityHealthService`'s "Background Queue" and "Scheduler" components — a DB outage stalls
  every in-process poller; confirm they resumed (`getLastPollAt()`/`getLastRunAt()` timestamps are recent).
