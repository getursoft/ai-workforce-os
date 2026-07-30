-- Stage 9D: add the TRIP_SUBMISSION workflow type — the third workflow on the generic
-- WorkflowExecution runtime, retiring the legacy trip-submission/standalone-contact state machine.
ALTER TYPE "workflow_type" ADD VALUE 'TRIP_SUBMISSION';
