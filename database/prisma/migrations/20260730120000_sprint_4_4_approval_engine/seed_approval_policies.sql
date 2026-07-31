-- Seed default approval policies for existing organizations
-- Run separately after migration: psql -f seed_approval_policies.sql

INSERT INTO approval_policies (id, organization_id, key, name, workflow_type, action_type, approver_type, mode, minimum_approvals, active, conditions_json, reapproval_rules_json, escalation_rules_json, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'TRAVEL_BOOKING_CUSTOMER_APPROVAL',
  'Travel Booking Customer Approval',
  'TRAVEL',
  'BOOKING',
  'CUSTOMER',
  'CUSTOMER_CONFIRMATION',
  1,
  true,
  '{}',
  '{"priceTolerancePercent": 5}',
  '{}',
  NOW(),
  NOW()
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM approval_policies p WHERE p.organization_id = o.id AND p.key = 'TRAVEL_BOOKING_CUSTOMER_APPROVAL'
);

INSERT INTO approval_policies (id, organization_id, key, name, workflow_type, action_type, approver_type, mode, minimum_approvals, active, conditions_json, reapproval_rules_json, escalation_rules_json, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'TRAVEL_CANCELLATION_MANAGER_APPROVAL',
  'Travel Cancellation Manager Approval',
  'TRAVEL',
  'CANCELLATION',
  'MANAGER',
  'SINGLE',
  1,
  true,
  '{}',
  '{}',
  '{}',
  NOW(),
  NOW()
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM approval_policies p WHERE p.organization_id = o.id AND p.key = 'TRAVEL_CANCELLATION_MANAGER_APPROVAL'
);

INSERT INTO approval_policies (id, organization_id, key, name, workflow_type, action_type, approver_type, mode, minimum_approvals, active, conditions_json, reapproval_rules_json, escalation_rules_json, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'HR_LEAVE_MANAGER_APPROVAL',
  'HR Leave Manager Approval',
  'HR',
  'LEAVE_REQUEST',
  'MANAGER',
  'SINGLE',
  1,
  true,
  '{}',
  '{}',
  '{}',
  NOW(),
  NOW()
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM approval_policies p WHERE p.organization_id = o.id AND p.key = 'HR_LEAVE_MANAGER_APPROVAL'
);
