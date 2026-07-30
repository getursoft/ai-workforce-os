-- Stage 9C: add the BOOKING_HANDOFF workflow type, proving WorkflowExecution supports a second,
-- generic workflow type alongside CONTACT_CAPTURE without any schema changes beyond the enum value.
ALTER TYPE "workflow_type" ADD VALUE 'BOOKING_HANDOFF';
