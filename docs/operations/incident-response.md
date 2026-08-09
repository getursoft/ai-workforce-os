# Incident Response

Sprint 5.0 Phase 15/28. General process; scenario-specific steps live in `docs/operations/runbooks/`.

## Process

1. **Detect** — via `/observability/health` (11 components + queue), alerts (`ObservabilityAlertsService`),
   or a user report.
2. **Triage severity** — see the table in `disaster-recovery.md`.
3. **Mitigate first, root-cause second.** For a SEV1, restoring service (rollback, restart, failover) takes
   priority over understanding why it broke — the "why" can wait for the retro.
4. **Communicate** — status to affected tenants if customer-visible; internal updates at a fixed cadence
   (e.g. every 30 min) so people aren't pinging for status instead of working the problem.
5. **Resolve and verify** — confirm via the same signal that detected the incident (health check green,
   alert cleared, user-reported symptom gone).
6. **Write it down** — even a few lines: what broke, what fixed it, what would have caught it sooner. This
   repo's own precedent (Sprint 4.7A's alert-dedup race condition, found via a user screenshot) shows real
   bugs get found by people looking at real data, not just by tests — capture that when it happens.

## Never do during an incident

- Skip authentication/authorization checks "temporarily" to unblock debugging.
- Disable rate limiting or billing enforcement platform-wide to work around a specific tenant's issue —
  scope the fix to that tenant instead.
- Run a destructive database operation without a fresh backup first (see `backup-and-restore.md`).
- Force-push, `--no-verify` a commit, or bypass code review to ship an incident fix, unless the severity
  and your organization's policy explicitly allow it — most incidents don't require that.

## Escalation

Encode your actual on-call/escalation path here once one exists (this repo has no paging integration —
`ObservabilityAlertsService` is in-app only, no PagerDuty/Slack webhook, per the Phase 1 audit).
