/**
 * Sprint 4.8 — Autonomous AI (Phase 17) + Memory Integration (Phase 11).
 *
 * Reminders are NOT hardcoded: the composer recalls the organization/employee/user memory context
 * through the existing MemoryService, merges the live workflow/entity context carried in the job, and
 * generates a contextual message. The decision service applies the deduplication policy so a reminder is
 * never sent twice for the same entity, and honors optional business hours.
 */

import { Injectable, Logger } from "@nestjs/common";
import { MemoryService } from "../memory/memory.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { MemoryContext } from "../memory/memory.types";

export interface ReminderDecision {
  shouldSend: boolean;
  /** Stable dedupe key for this reminder+entity — persisted in memory so a re-run never resends. */
  dedupeKey: string;
  reason: "SEND" | "ALREADY_SENT" | "OUTSIDE_BUSINESS_HOURS" | "ENTITY_RESOLVED" | "NOT_DUE";
  message?: string;
  subject?: string;
  /** Facts pulled from memory to enrich the message. */
  contextFacts: Array<{ category: string; key: string; value: unknown }>;
}

export interface ReminderInput {
  organizationId: string;
  employeeId: string | null;
  definitionKey: string;
  /** Kind used to build the dedupe key, e.g. "travel.pre_travel". */
  kind: string;
  /** The entity the reminder targets (bookingId, approvalRequestId, leaveId, ...). */
  entityId: string | null;
  entityStatus?: string | null;
  /** Optional business-hours gate { timezone, start, end } in the schedule's timezone. */
  businessHours?: { timezone?: string | null; start?: string | null; end?: string | null } | null;
  /** Optional human recipient for the greeting line. */
  recipientName?: string | null;
  /** Optional user id to scope memory recall. */
  userId?: string | null;
  conversationId?: string | null;
  payload: Record<string, unknown>;
}

export interface ComposedReminder {
  subject: string;
  body: string;
}

const DEDUPE_MEMORY_CATEGORY = "SCHEDULER";
const DEDUPE_KEY_PREFIX = "scheduler.reminder.sent";

function readTime(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value)) return value;
  return fallback;
}

function currentTimeInZone(timeZone: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const weekdayText = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return { hour: get("hour"), minute: get("minute"), weekday: weekdayMap[weekdayText] ?? 0 };
}

@Injectable()
export class ReminderComposer {
  private readonly logger = new Logger(ReminderComposer.name);

  constructor(
    private readonly memory: MemoryService,
    private readonly prisma: PrismaService
  ) {}

  /** Builds the stable dedupe key used by BOTH the memory dedup record and the job's dedupeKey. */
  static dedupeKeyFor(kind: string, entityId: string | null): string {
    return `${DEDUPE_KEY_PREFIX}:${kind}${entityId ? `:${entityId}` : ""}`;
  }

  /**
   * Decides whether a reminder should be sent right now and (when yes) composes the contextual message.
   * Never throws — a decision of SKIP is a successful no-op for the caller.
   */
  async decide(input: ReminderInput): Promise<ReminderDecision> {
    const dedupeKey = ReminderComposer.dedupeKeyFor(input.kind, input.entityId);
    const alreadySent = input.entityId
      ? await this.hasSentReminder(input.organizationId, input.employeeId, dedupeKey)
      : false;
    if (alreadySent)
      return { shouldSend: false, dedupeKey, reason: "ALREADY_SENT", contextFacts: [] };

    if (input.entityStatus === "RESOLVED") {
      return { shouldSend: false, dedupeKey, reason: "ENTITY_RESOLVED", contextFacts: [] };
    }

    if (input.businessHours?.timezone) {
      const timeZone = input.businessHours.timezone;
      const start = readTime(input.businessHours.start, "09:00");
      const end = readTime(input.businessHours.end, "18:00");
      const startParts = start.split(":");
      const endParts = end.split(":");
      const startHour = Number(startParts[0]) || 0;
      const startMinute = Number(startParts[1]) || 0;
      const endHour = Number(endParts[0]) || 0;
      const endMinute = Number(endParts[1]) || 0;
      const now = currentTimeInZone(timeZone);
      const minutes = now.hour * 60 + now.minute;
      const startTotal = startHour * 60 + startMinute;
      const endTotal = endHour * 60 + endMinute;
      if (endTotal > startTotal && (minutes < startTotal || minutes >= endTotal)) {
        return { shouldSend: false, dedupeKey, reason: "OUTSIDE_BUSINESS_HOURS", contextFacts: [] };
      }
    }

    const memoryContext = await this.recallMemory(input);
    const composed = this.compose(input, memoryContext);
    return {
      shouldSend: true,
      dedupeKey,
      reason: "SEND",
      message: composed.body,
      subject: composed.subject,
      contextFacts: [
        ...memoryContext.organization,
        ...memoryContext.employee,
        ...memoryContext.user
      ]
    };
  }

  /** Marks a reminder as sent so subsequent runs of the same job for the same entity are no-ops. */
  async markSent(input: ReminderInput, dedupeKey: string): Promise<void> {
    try {
      await this.memory.remember({
        organizationId: input.organizationId,
        scope: input.employeeId ? "EMPLOYEE" : "ORGANIZATION",
        ...(input.employeeId ? { employeeId: input.employeeId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        key: dedupeKey,
        category: DEDUPE_MEMORY_CATEGORY,
        value: {
          definitionKey: input.definitionKey,
          entityId: input.entityId,
          sentAt: new Date().toISOString()
        },
        source: "SYSTEM",
        importance: "LOW",
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
        actorId: null
      });
    } catch (error) {
      this.logger.warn({ event: "REMINDER_MARK_FAILED", dedupeKey, error: String(error) });
    }
  }

  private async hasSentReminder(
    organizationId: string,
    employeeId: string | null,
    dedupeKey: string
  ): Promise<boolean> {
    try {
      const count = await this.prisma.memoryRecord.count({
        where: {
          organizationId,
          deletedAt: null,
          key: dedupeKey,
          ...(employeeId ? { employeeId } : {})
        }
      });
      return count > 0;
    } catch {
      return false;
    }
  }

  private async recallMemory(input: ReminderInput): Promise<MemoryContext> {
    if (!input.employeeId)
      return {
        organization: [],
        employee: [],
        user: [],
        conversationSummary: null,
        conversationSummaryVersion: null
      };
    try {
      return await this.memory.recall(input.organizationId, {
        userId: input.userId ?? null,
        employeeId: input.employeeId,
        conversationId: input.conversationId ?? null
      });
    } catch {
      return {
        organization: [],
        employee: [],
        user: [],
        conversationSummary: null,
        conversationSummaryVersion: null
      };
    }
  }

  /** Composes a contextual reminder from memory facts + the live entity context — never a static string. */
  private compose(input: ReminderInput, memory: MemoryContext): ComposedReminder {
    const greeting = input.recipientName ? `Hi ${input.recipientName}` : "Hi";
    const purpose = purposeLine(input.definitionKey);
    const facts = this.recallLines(memory);
    const contextLines = this.contextLines(input);
    const body = [
      greeting,
      purpose,
      ...contextLines,
      ...(facts.length ? ["", "A few things I remember:", ...facts] : [])
    ].join("\n");
    return { subject: subjectFor(input.definitionKey), body };
  }

  private recallLines(memory: MemoryContext): string[] {
    const lines: string[] = [];
    const push = (records: Array<{ category: string; key: string; value: unknown }>) => {
      for (const record of records.slice(0, 4)) {
        const value =
          typeof record.value === "object" && record.value !== null
            ? JSON.stringify(record.value)
            : String(record.value);
        lines.push(`- ${record.key}: ${value.slice(0, 120)}`);
      }
    };
    push(memory.organization);
    push(memory.employee);
    push(memory.user);
    return lines;
  }

  private contextLines(input: ReminderInput): string[] {
    const lines: string[] = [];
    const known: Record<string, string> = {
      reference: "reference",
      bookingRef: "booking reference",
      providerPnr: "PNR",
      travelDates: "travel dates",
      destinationCity: "destination",
      leaveType: "leave type",
      amount: "amount",
      currency: "currency",
      dueDate: "due date",
      expiryDate: "expiry date",
      contractName: "contract",
      hearingDate: "hearing date",
      courtName: "court",
      invoiceNumber: "invoice",
      proposalName: "proposal",
      noticeType: "notice type"
    };
    for (const [key, label] of Object.entries(known)) {
      const value = input.payload[key] ?? input.payload[`${key}Value`];
      if (value !== undefined && value !== null && value !== "") {
        lines.push(`- ${label}: ${String(value).slice(0, 160)}`);
      }
    }
    return lines;
  }
}

function purposeLine(definitionKey: string): string {
  const purposes: Record<string, string> = {
    "travel.reminder.pre_travel": "A quick reminder about your upcoming travel.",
    "travel.reminder.visa_expiry": "This is a reminder that a visa expiry is approaching.",
    "travel.reminder.passport_expiry": "A friendly reminder that a passport expiry is approaching.",
    "travel.reminder.quotation_followup": "I wanted to follow up on the travel quotation I shared.",
    "travel.reminder.booking_reminder": "A reminder about your travel booking.",
    "travel.reminder.approval_pending":
      "Just a reminder that your booking is still awaiting approval.",
    "hr.reminder.manager_approval": "A reminder that a leave request is awaiting your approval.",
    "hr.reminder.leave_before": "A reminder ahead of your upcoming leave.",
    "hr.reminder.joining": "A reminder ahead of your joining date.",
    "hr.reminder.probation": "A reminder that your probation period is nearing completion.",
    "finance.reminder.invoice": "A reminder about an outstanding invoice.",
    "finance.reminder.payment": "A reminder about a payment that is due.",
    "finance.reminder.reimbursement": "A reminder about a pending reimbursement.",
    "legal.reminder.contract": "A reminder that a contract is approaching renewal.",
    "legal.reminder.court": "A reminder about an upcoming court hearing.",
    "sales.reminder.lead_followup": "A follow-up on the lead we discussed.",
    "sales.reminder.proposal": "A reminder about the proposal that was shared."
  };
  return purposes[definitionKey] ?? "A reminder from your AI Employee.";
}

function subjectFor(definitionKey: string): string {
  const subjects: Record<string, string> = {
    "travel.reminder.pre_travel": "Upcoming travel reminder",
    "travel.reminder.visa_expiry": "Visa expiry reminder",
    "travel.reminder.passport_expiry": "Passport expiry reminder",
    "travel.reminder.quotation_followup": "Quotation follow-up",
    "travel.reminder.booking_reminder": "Travel booking reminder",
    "travel.reminder.approval_pending": "Booking approval reminder",
    "hr.reminder.manager_approval": "Leave approval reminder",
    "hr.reminder.leave_before": "Leave reminder",
    "hr.reminder.joining": "Joining reminder",
    "hr.reminder.probation": "Probation reminder",
    "finance.reminder.invoice": "Invoice reminder",
    "finance.reminder.payment": "Payment reminder",
    "finance.reminder.reimbursement": "Reimbursement reminder",
    "legal.reminder.contract": "Contract renewal reminder",
    "legal.reminder.court": "Court hearing reminder",
    "sales.reminder.lead_followup": "Lead follow-up",
    "sales.reminder.proposal": "Proposal reminder"
  };
  return subjects[definitionKey] ?? "AI Employee reminder";
}
