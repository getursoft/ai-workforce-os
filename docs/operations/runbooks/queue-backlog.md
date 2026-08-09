# Runbook: Queue Backlog

## Symptoms
- `ObservabilityHealthService`'s "Background Queue" component reports `DEGRADED`.
- `QueueHealthService.snapshot()` shows `staleClaims > 0` or `oldestQueuedMs > 5 minutes`.

## Immediate checks
1. **Stale claims** (a worker claimed a message and crashed/stalled before completing it): the durable
   queue (`PostgresQueueAdapter.recover()`) automatically returns these to `QUEUED` once their visibility
   lease (`QUEUE_VISIBILITY_MS`, default 60s) elapses — `staleClaims > 0` briefly during a worker restart is
   expected, not incident-worthy. Persistent staleClaims means workers are crashing faster than they can
   process a message's visibility window; check worker logs for the crash cause.
2. **Growing queue depth with no stale claims**: no worker process is running, or `PROCESS_ROLE` on every
   running process excludes queue consumption. `QueueConsumerWorker` only polls in processes where
   `PROCESS_ROLE` is `all`, `workforce-worker`, or `maintenance` (Sprint 5.0 Phase 3) — confirm at least one
   deployed process has one of those roles.
3. **Dead-lettered messages accumulating**: a handler is consistently failing (exhausted `maxAttempts`,
   default 5, exponential backoff). Check `errorCode`/`errorMessage` on the dead-lettered rows
   (`queueMessage.findMany({where: {status: "DEAD_LETTERED"}})`) — this is the same information a
   `NO_HANDLER` error would show if a category was published with no registered consumer.

## Mitigation
- Scale up `workforce-worker`/`maintenance`-role process count if the backlog is genuine load, not a bug.
- Increase `WORKER_CONCURRENCY` (bounded by target throughput and downstream capacity — a queue worker
  consuming faster than the systems it calls can handle just moves the bottleneck).
- For dead-lettered messages caused by a since-fixed bug: no automated reprocessing endpoint exists yet in
  this pass — republish manually via `BackgroundQueue.publish()` with the same `refType`/`refId` once the
  underlying handler bug is fixed, or via a direct DB update moving status back to `QUEUED` for that
  specific message id (never bulk-reset dead letters without first understanding why they failed).

## Note on current scope

As of Sprint 5.0, the queue adapter (`PostgresQueueAdapter`) is fully wired for dependency injection and
health-checked, but the existing scheduler/workforce/channel processors still use their own direct
database polling rather than publishing through this queue — migrating them is tracked as follow-up work,
not yet done. This runbook applies once a producer is wired to it.
