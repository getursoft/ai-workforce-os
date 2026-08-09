/**
 * Sprint 4.8 — Autonomous Follow-ups catalog (Phase 7) + Job Templates.
 *
 * These are the built-in job definitions every organization can schedule. They are pure data: the actual
 * behaviour lives in SchedulerHandlers (SEND_REMINDER / START_WORKFLOW / REQUEST_APPROVAL / ...). The
 * catalog is seeded lazily into the job_definitions table by SchedulerService.onModuleInit, and the
 * JobTemplates below are exposed through the templates API so a customer (or the scheduler dashboard) can
 * instantiate a follow-up in one click.
 */

import type { JobDefinitionSeed, JobTemplateSeed } from "./job-registry.types";

export const JOB_DEFINITION_SEEDS: JobDefinitionSeed[] = [
  // ------------------------------------------------------------------ Travel
  {
    key: "travel.reminder.pre_travel",
    name: "Travel reminder",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Remind the customer before travel (dates, baggage, check-in).",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "travel.reminder.visa_expiry",
    name: "Visa expiry reminder",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Remind the customer before a visa expires.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "travel.reminder.passport_expiry",
    name: "Passport expiry reminder",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Remind the customer before a passport expires.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "travel.reminder.quotation_followup",
    name: "Quotation follow-up",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Follow up after a travel quotation is shared.",
    retryPolicy: "30_MIN",
    maxRetry: 5
  },
  {
    key: "travel.reminder.booking_reminder",
    name: "Booking reminder",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Remind the customer about an upcoming booked trip.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "travel.reminder.approval_pending",
    name: "Booking approval reminder",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Remind the customer that their booking awaits approval.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "scheduler.booking_approved_followup",
    name: "Booking approved follow-up",
    category: "TRAVEL",
    handlerType: "SEND_REMINDER",
    description: "Reach out automatically after a booking is approved.",
    retryPolicy: "30_MIN",
    maxRetry: 5,
    eventName: "booking.approved"
  },
  // ------------------------------------------------------------------ HR
  {
    key: "hr.reminder.manager_approval",
    name: "Leave approval reminder",
    category: "HR",
    handlerType: "SEND_REMINDER",
    description: "Remind a manager of a pending leave approval.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "hr.reminder.leave_before",
    name: "Leave reminder",
    category: "HR",
    handlerType: "SEND_REMINDER",
    description: "Remind an employee before their leave starts.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "hr.reminder.joining",
    name: "Joining reminder",
    category: "HR",
    handlerType: "SEND_REMINDER",
    description: "Remind HR/employee ahead of the joining date.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "hr.reminder.probation",
    name: "Probation reminder",
    category: "HR",
    handlerType: "SEND_REMINDER",
    description: "Remind HR before probation completion.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  // ------------------------------------------------------------------ Finance
  {
    key: "finance.reminder.invoice",
    name: "Invoice reminder",
    category: "FINANCE",
    handlerType: "SEND_REMINDER",
    description: "Remind a customer about an outstanding invoice.",
    retryPolicy: "30_MIN",
    maxRetry: 5
  },
  {
    key: "finance.reminder.payment",
    name: "Payment reminder",
    category: "FINANCE",
    handlerType: "SEND_REMINDER",
    description: "Remind about a payment that is due.",
    retryPolicy: "30_MIN",
    maxRetry: 5
  },
  {
    key: "finance.reminder.reimbursement",
    name: "Reimbursement reminder",
    category: "FINANCE",
    handlerType: "SEND_REMINDER",
    description: "Remind about a pending reimbursement.",
    retryPolicy: "30_MIN",
    maxRetry: 5
  },
  // ------------------------------------------------------------------ Legal
  {
    key: "legal.reminder.contract",
    name: "Contract renewal reminder",
    category: "LEGAL",
    handlerType: "SEND_REMINDER",
    description: "Remind about a contract approaching renewal.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  {
    key: "legal.reminder.court",
    name: "Court hearing reminder",
    category: "LEGAL",
    handlerType: "SEND_REMINDER",
    description: "Remind about an upcoming court hearing.",
    retryPolicy: "5_MIN",
    maxRetry: 5
  },
  // ------------------------------------------------------------------ Sales
  {
    key: "sales.reminder.lead_followup",
    name: "Lead follow-up",
    category: "SALES",
    handlerType: "SEND_REMINDER",
    description: "Follow up with a new sales lead.",
    retryPolicy: "30_MIN",
    maxRetry: 5
  },
  {
    key: "sales.reminder.proposal",
    name: "Proposal reminder",
    category: "SALES",
    handlerType: "SEND_REMINDER",
    description: "Remind about a proposal that was shared.",
    retryPolicy: "30_MIN",
    maxRetry: 5
  },
  {
    key: "scheduler.lead_followup",
    name: "Lead created follow-up",
    category: "PLATFORM",
    handlerType: "SEND_REMINDER",
    description: "Follow up automatically when a lead is created.",
    retryPolicy: "30_MIN",
    maxRetry: 5,
    eventName: "lead.created"
  },
  // ------------------------------------------------------------------ Platform / workflow
  {
    key: "platform.recurring_report",
    name: "Recurring report",
    category: "PLATFORM",
    handlerType: "RUN_AGENT",
    description: "Generate a recurring (e.g. monthly) report via the employee.",
    retryPolicy: "30_MIN",
    maxRetry: 3
  },
  {
    key: "platform.skill_execution",
    name: "Scheduled skill execution",
    category: "PLATFORM",
    handlerType: "RUN_SKILL",
    description: "Run an installed skill on a schedule (e.g. parse a daily report, translate weekly content, generate a recurring extract).",
    retryPolicy: "30_MIN",
    maxRetry: 3
  },
  {
    key: "scheduler.pending_approval_scan",
    name: "Pending approval scanner",
    category: "PLATFORM",
    handlerType: "PENDING_APPROVAL_SCAN",
    description: "Scan for pending approvals and schedule reminders.",
    retryPolicy: "30_MIN",
    maxRetry: 3
  },
  {
    key: "scheduler.escalate_approval",
    name: "Escalate approval",
    category: "PLATFORM",
    handlerType: "ESCALATE_APPROVAL",
    description: "Escalate a stale pending approval to its approvers.",
    retryPolicy: "2_HOUR",
    maxRetry: 3
  },
  {
    key: "scheduler.request_approval",
    name: "Request approval",
    category: "PLATFORM",
    handlerType: "REQUEST_APPROVAL",
    description: "Create an approval request through the Approval Engine.",
    retryPolicy: "5_MIN",
    maxRetry: 3
  },
  {
    key: "scheduler.start_workflow",
    name: "Start workflow",
    category: "PLATFORM",
    handlerType: "START_WORKFLOW",
    description: "Run a durable workflow through the Workflow Engine.",
    retryPolicy: "5_MIN",
    maxRetry: 3
  },
  {
    key: "scheduler.publish_event",
    name: "Publish event",
    category: "PLATFORM",
    handlerType: "PUBLISH_EVENT",
    description: "Emit a scheduler domain event (job chaining).",
    retryPolicy: "IMMEDIATE",
    maxRetry: 3
  }
];

export const JOB_TEMPLATE_SEEDS: JobTemplateSeed[] = [
  // Travel
  {
    name: "Travel reminder",
    description: "Remind the customer before travel (daily 09:00).",
    definitionKey: "travel.reminder.pre_travel",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Visa expiry reminder",
    description: "Daily check for approaching visa expiry.",
    definitionKey: "travel.reminder.visa_expiry",
    triggerType: "DAILY",
    atTime: "09:30"
  },
  {
    name: "Passport expiry reminder",
    description: "Daily check for approaching passport expiry.",
    definitionKey: "travel.reminder.passport_expiry",
    triggerType: "DAILY",
    atTime: "09:30"
  },
  {
    name: "Quotation follow-up",
    description: "Follow up 24h after a quotation is shared.",
    definitionKey: "travel.reminder.quotation_followup",
    triggerType: "INTERVAL",
    interval: "24h"
  },
  {
    name: "Booking reminder",
    description: "Daily booking reminder before departure.",
    definitionKey: "travel.reminder.booking_reminder",
    triggerType: "DAILY",
    atTime: "10:00"
  },
  {
    name: "Booking approval reminder",
    description: "Remind the customer while a booking awaits approval.",
    definitionKey: "travel.reminder.approval_pending",
    triggerType: "DAILY",
    atTime: "11:00"
  },
  // HR
  {
    name: "Manager leave approval reminder",
    description: "Remind managers of pending leave approvals.",
    definitionKey: "hr.reminder.manager_approval",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Leave reminder",
    description: "Remind employees before leave starts.",
    definitionKey: "hr.reminder.leave_before",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Joining reminder",
    description: "Remind ahead of the joining date.",
    definitionKey: "hr.reminder.joining",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Probation reminder",
    description: "Remind HR before probation completion.",
    definitionKey: "hr.reminder.probation",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  // Finance
  {
    name: "Invoice reminder",
    description: "Remind about outstanding invoices.",
    definitionKey: "finance.reminder.invoice",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Payment reminder",
    description: "Remind about due payments.",
    definitionKey: "finance.reminder.payment",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Reimbursement reminder",
    description: "Remind about pending reimbursements.",
    definitionKey: "finance.reminder.reimbursement",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  // Legal
  {
    name: "Contract renewal reminder",
    description: "Remind before contract renewal.",
    definitionKey: "legal.reminder.contract",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  {
    name: "Court hearing reminder",
    description: "Remind about court hearings.",
    definitionKey: "legal.reminder.court",
    triggerType: "DAILY",
    atTime: "09:00"
  },
  // Sales
  {
    name: "Lead follow-up",
    description: "Follow up 24h after a lead is captured.",
    definitionKey: "sales.reminder.lead_followup",
    triggerType: "INTERVAL",
    interval: "24h"
  },
  {
    name: "Proposal reminder",
    description: "Remind about shared proposals.",
    definitionKey: "sales.reminder.proposal",
    triggerType: "INTERVAL",
    interval: "24h"
  },
  // Platform
  {
    name: "Monthly report",
    description: "Generate a recurring monthly report (1st of month, 08:00).",
    definitionKey: "platform.recurring_report",
    triggerType: "MONTHLY",
    dayOfMonth: 1,
    atTime: "08:00"
  },
  {
    name: "Pending approval scanner",
    description: "Scan every 30 minutes for pending approvals.",
    definitionKey: "scheduler.pending_approval_scan",
    triggerType: "INTERVAL",
    interval: "30m"
  },
  {
    name: "Booking approved follow-up",
    description: "Event-driven follow-up after a booking is approved.",
    definitionKey: "scheduler.booking_approved_followup",
    triggerType: "AFTER_BOOKING"
  },
  {
    name: "Lead created follow-up",
    description: "Event-driven follow-up after a lead is created.",
    definitionKey: "scheduler.lead_followup",
    triggerType: "EVENT",
    eventName: "lead.created"
  }
];
