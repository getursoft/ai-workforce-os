# Sprint 4.8 — Autonomous Scheduler & Background Execution Engine

## Objective

Before Sprint 4.8 the AI Workforce OS was purely reactive: an employee only worked when a customer (or a
dashboard user) sent a message. Sprint 4.8 adds **autonomous execution** on top of the existing platform —
scheduled reminders, follow-ups, escalation, and recurring work — so every AI Employee becomes proactive
(Travel, HR, Finance, Legal, Sales, …).

This sprint is strictly **additive**. The Workflow Engine, Approval Engine, Memory Engine, Delegation
Engine, Observability, Billing, existing APIs, existing dashboard pages, and the plugin runtime are used
as-is. The scheduler never rewrites or duplicates any of them.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ SchedulerModule (apps/api/src/scheduler)                             │
│                                                                       │
│  SchedulerService          worker loop + event subscription + API     │
│  JobDispatcher             due schedules → QUEUED executions (locked) │
│  JobExecutor               claims QUEUED/RETRYING → runs handler      │
│  JobHistoryService         execution rows + monitoring reads          │
│  JobLockService            optimistic per-job leases (crash-safe)     │
│  JobRetryService           exponential-backoff ladder + DLQ           │
│  JobRegistry               definition catalog + handler resolution    │
│  SchedulerHandlers         SEND_REMINDER / START_WORKFLOW / ...       │
│  ReminderComposer          memory-aware decision + message composer   │
│  SchedulerDeliveryService  WhatsApp / email / in-app delivery         │
│  SchedulerEventBridge      approval events + reconciliation scan      │
│  SchedulerWorkerHealth     heartbeat + counters                       │
│  cron/schedule-time        timezone/DST-aware next-run computation    │
└─────────────────────────────────────────────────────────────────────┘
            │ reuses
            ▼
   WorkflowExecutionService · ApprovalService · AgentService ·
   MemoryService · WorkforceEventBus · EmailService · Channel infra ·
   ObservabilityService (Sprint 4.7 traces)
```

Workers are process-local (like `WorkforceTaskProcessor`): an interval drives `tick()` which publishes due
jobs, executes queued work, reconciles event sources, and recovers abandoned runs. Multiple API instances
are supported — the DB-backed job locks + execution `dedupeKey` guarantee exactly-once dispatch.

## Database models

New Prisma enums/models (migration `20260803180137_sprint_4_8_autonomous_scheduler`):

- `JobDefinition` — the global catalog of executable jobs (key, handlerType, retryPolicy, maxRetry,
  timeoutMs, eventName). Seeded lazily at startup from `autonomous-job-definitions.ts`.
- `JobTemplate` — reusable schedule blueprints (global + org-scoped). Instantiable in one click.
- `ScheduledJob` — one durable schedule (organizationId, employeeId, workflowId, definitionKey,
  triggerType, cronExpression/intervalMs, timezone, status, priority, nextRun/lastRun, retryCount,
  maxRetry, timeoutMs, payload, context, unique `dedupeKey`).
- `ScheduledExecution` — one run (status QUEUED/RUNNING/FAILED/RETRYING/COMPLETED/CANCELLED/TIMEOUT/
  DEAD_LETTERED, scheduledFor, attemptCount, durationMs, nextAttemptAt, traceId, workerId, result,
  errorCode/message, tokens, credits, unique `dedupeKey`).
- `JobLock` — per-job optimistic lock (unique jobId, workerId, version, leaseExpiresAt).
- `WorkflowType.AUTONOMOUS_REMINDER` — new enum value so the scheduler can track reminder workflows through
  the existing Workflow Execution Engine (persistence only; never turn dispatch).

## Scheduler engine

- `SchedulerService.createSchedule` computes `nextRun` from the trigger type (cron/interval/daily/weekly/
  monthly/one-time) in the schedule's IANA timezone.
- `JobDispatcher.publishDueJobs` finds due ACTIVE jobs (time-based triggers only), claims each through
  `JobLockService`, creates a QUEUED execution with a `jobId:scheduledFor` dedupe key, then advances the
  schedule (recurring → next run; one-shot → COMPLETED).
- `JobExecutor.processQueue` claims the highest-priority QUEUED execution (and due RETRYING attempts), runs
  the registered handler inside a Sprint 4.7 trace (`BACKGROUND_TASK` span), enforces the job timeout, and
  finalizes COMPLETED / RETRYING / DEAD_LETTERED / TIMEOUT.
- Every run writes a `ScheduledExecution` row and a trace (job.started → handler internals → job.completed /
  job.failed / job.timed_out), all visible in the existing Trace Viewer.

## Worker engine

- `SchedulerWorkerHealth` tracks the worker id, last poll, running/completed/failed/retried counters,
  CPU time, memory, uptime, and queue latency; exposed via `GET /api/v1/scheduler/worker/health` and the
  overview payload.
- Worker start/stop hooks are wired through `OnModuleInit`/`OnModuleDestroy`; the polling interval is
  skipped under `NODE_ENV=test` (tests drive `tick()` directly).

## Retry engine

- Retry policies: `IMMEDIATE`, `30_SEC`, `2_MIN`, `5_MIN`, `30_MIN`, `2_HOUR`, `24_HOUR`, `NONE`.
- Exponential backoff ladder per policy, bounded by `maxRetry`. Failed/timed-out runs move to `RETRYING`
  with `nextAttemptAt`; runs that exhaust the budget land on the **dead letter queue** (`DEAD_LETTERED`)
  for manual retry via the API/dashboard.

## Event integration

- The scheduler subscribes to the existing `WorkforceEventBus.approval.decided` (already emitted by the
  Approval Engine) and re-emits `approval.completed`, `booking.approved`, `booking.cancelled`,
  `leave.approved`.
- `SchedulerEventBridge.reconcile(orgId)` scans the domain tables (payments, knowledge documents, leads,
  bookings, HR leave) against a persisted high-water mark in memory, emitting `payment.received`,
  `document.uploaded`, `lead.created`, etc. This is crash-safe: an event missed while the worker was down is
  picked up on the next scan.
- Event-triggered jobs (`AFTER_APPROVAL`, `AFTER_BOOKING`, `AFTER_WORKFLOW`, `AFTER_PAYMENT`, `AFTER_UPLOAD`,
  `EVENT`) stay ACTIVE with `nextRun = null` and dispatch exactly once per (job, event name, entityId) via a
  unique execution `dedupeKey`.

## Workflow integration

- `scheduler.start_workflow` uses `WorkflowExecutionService` (the existing engine) to create and close an
  `AUTONOMOUS_REMINDER` workflow around the reminder body — no duplicated logic.
- `scheduler.request_approval` / `scheduler.escalate_approval` reuse `ApprovalService` and
  `ApprovalAuditService`; `scheduler.pending_approval_scan` scans pending approvals and schedules one
  reminder per approval (Phase 13).

## Approval integration

- Pending approvals automatically generate reminders (`PENDING_APPROVAL_SCAN`), with configurable intervals
  and a dedupe key per approval; stale approvals can be escalated to their approvers.

## Dashboard

- New `/scheduler` dashboard page (Overview, Jobs, Executions, Templates tabs) with worker health, queue
  stats, upcoming jobs, recent executions, pause/resume/cancel/retry actions, and template instantiation.
- Gated by `scheduler.read` (page) and `scheduler.write` (actions).

## APIs (REST, `/api/v1/scheduler`)

- `GET  /scheduler/overview` · `GET /scheduler/worker/health` · `GET /scheduler/definitions`
- `GET  /scheduler/templates` · `POST /scheduler/templates/:id/instantiate`
- `GET  /scheduler/upcoming`
- `GET/POST /scheduler/jobs` · `GET /scheduler/jobs/:id`
- `POST /scheduler/jobs/one-shot`
- `POST /scheduler/jobs/:id/pause|resume|cancel`
- `GET  /scheduler/executions` · `GET /scheduler/executions/:id` · `POST /scheduler/executions/:id/retry`

## Worker health

Exposed in `WorkerHealthView`: status (RUNNING/IDLE/STALE/STOPPED), pid, started/lastHeartbeat/lastPoll,
running/completed/failed/retried counts, CPU time, memory, uptime, queue latency, poll interval.

## Trace integration

Every execution runs inside an `ObservabilityService.withSpan` `BACKGROUND_TASK` span; the traceId is
persisted back on the `ScheduledExecution` row so the scheduler dashboard links straight into the Trace
Viewer. Nested engine calls (workflows, approvals, agent runs) attach their own spans to the same trace.

## Security

- RBAC permissions: `scheduler.read`, `scheduler.write`, `scheduler.retry`, `scheduler.template.read`,
  `scheduler.template.write`, `scheduler.worker.read` (seeded to Owner/Admin/Manager/Viewer).
- Every schedule/execution is hard tenant-scoped by `organizationId`; no query crosses tenants.
- Deliveries and failures are audited through `AuditEventLogger`; approvals go through the Approval Engine.
- Jobs may target a specific employee (Plugin installation) or run org-wide (service-account style).

## Runtime UAT

Covered end-to-end by `scheduler.integration.spec.ts` + `reminder-composer.spec.ts`:
travel booking reminder, travel approval reminder, HR leave reminder, lead follow-up, recurring monthly
report (template instantiation), retry after simulated failure, worker-restart lock recovery, abandoned-run
recovery, duplicate-execution prevention (dedupe + concurrent workers), event-driven booking follow-up,
multi-tenant isolation, dashboard/overview/worker-health data, REST API + RBAC, and trace generation.

## Tests

- Unit: cron/next-run engine (incl. timezone + DST), retry ladder/backoff.
- Integration: `scheduler.integration.spec.ts` (16 tests), `reminder-composer.spec.ts` (4 tests) covering
  create→dispatch→complete, exactly-once, dedupe, priority ordering, multi-tenant isolation, exponential
  backoff + dead lettering, crash recovery, lock steal, event-driven dispatch, approval reminder scan,
  template instantiation, overview/worker health, REST + RBAC, and trace generation.
- No regressions: full API suite passes with only the 6 pre-existing failures (agent/knowledge/travel LLM
  tests that fail on the base commit too).

## Performance

- Polling tick processes up to 10 queued + 25 retry executions per pass; queues are indexed on
  (status, priority) and (status, nextAttemptAt).
- Execution and job `dedupeKey` unique indexes make duplicate dispatch a no-op at the DB level.
- Watermark-based reconciliation avoids scanning the whole domain on every tick (throttled to ~every 30s).

## Remaining limitations

- Reminders are delivered best-effort: WhatsApp delivery records an OUTBOUND `ChannelMessage` row through
  the existing channel infrastructure (no live provider call from the scheduler), email only when SMTP is
  configured.
- One in-process scheduler per API instance is supported; a distributed leader-election coordinator for
  sharded execution across instances is future work (DB locks already prevent duplicate work today).
- Business-hours gating is optional per payload; org-wide default business hours are not yet a setting.
- The reconciliation scan has a ~30s resolution (event-driven jobs are effectively near-real-time, not
  millisecond).
