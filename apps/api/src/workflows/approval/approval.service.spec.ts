import { describe, expect, it, vi, beforeEach } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ApprovalService } from "./approval.service";

const NOW = new Date("2026-07-28T12:00:00Z");

function createMockPrisma() {
  const rows: Map<string, Record<string, unknown>> = new Map();
  return {
    approvalRequest: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const id = `req-${rows.size + 1}`;
        const record = {
          id,
          organizationId: data.organizationId,
          workflowExecutionId: data.workflowExecutionId,
          agentId: data.agentId,
          requestedBy: data.requestedBy,
          status: data.status ?? "PENDING",
          title: data.title,
          description: data.description,
          payload: data.payload ?? {},
          comments: data.comments ?? [],
          approvedAt: null,
          approvedBy: null,
          createdAt: NOW,
          updatedAt: NOW
        };
        rows.set(id, record);
        return record;
      }),
      findFirst: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        for (const record of rows.values()) {
          if (record.id === where.id && record.organizationId === where.organizationId) return record;
        }
        return null;
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const existing = rows.get(where.id as string);
        if (!existing) throw new Error("Not found");
        const updated = { ...existing, ...data, updatedAt: NOW };
        rows.set(where.id as string, updated);
        return updated;
      })
    }
  };
}

describe("ApprovalService", () => {
  let service: ApprovalService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new ApprovalService(prisma as unknown as ApprovalService extends { prisma: infer P } ? P : never);
  });

  it("creates an approval request with PENDING status", async () => {
    const result = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Approve booking", description: "Dubai trip needs approval"
    });
    expect(result.status).toBe("PENDING");
    expect(result.title).toBe("Approve booking");
  });

  it("approves a PENDING request", async () => {
    const created = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Test", description: "Test"
    });
    const result = await service.approve({
      approvalRequestId: created.id, organizationId: "org-1", approvedBy: "manager-1"
    });
    expect(result.status).toBe("APPROVED");
    expect(result.approvedBy).toBe("manager-1");
  });

  it("rejects a PENDING request", async () => {
    const created = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Test", description: "Test"
    });
    const result = await service.reject({
      approvalRequestId: created.id, organizationId: "org-1", rejectedBy: "manager-1"
    });
    expect(result.status).toBe("REJECTED");
  });

  it("prevents APPROVED -> APPROVED transition", async () => {
    const created = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Test", description: "Test"
    });
    await service.approve({
      approvalRequestId: created.id, organizationId: "org-1", approvedBy: "mgr-1"
    });
    await expect(
      service.approve({ approvalRequestId: created.id, organizationId: "org-1", approvedBy: "mgr-2" })
    ).rejects.toThrow(BadRequestException);
  });

  it("prevents REJECTED -> APPROVED transition", async () => {
    const created = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Test", description: "Test"
    });
    await service.reject({
      approvalRequestId: created.id, organizationId: "org-1", rejectedBy: "mgr-1"
    });
    await expect(
      service.approve({ approvalRequestId: created.id, organizationId: "org-1", approvedBy: "mgr-2" })
    ).rejects.toThrow(BadRequestException);
  });

  it("throws NotFoundException for non-existent request", async () => {
    await expect(
      service.approve({ approvalRequestId: "not-found", organizationId: "org-1", approvedBy: "mgr-1" })
    ).rejects.toThrow(NotFoundException);
  });

  it("enforces tenant isolation — cannot find other org's request", async () => {
    const created = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Test", description: "Test"
    });
    const found = await service.findById(created.id, "other-org");
    expect(found).toBeNull();
  });

  it("expires a PENDING request", async () => {
    const created = await service.create({
      organizationId: "org-1", workflowExecutionId: "wf-1",
      agentId: "agent-1", requestedBy: "user-1",
      title: "Test", description: "Test"
    });
    const result = await service.expire("org-1", created.id);
    expect(result.status).toBe("EXPIRED");
  });
});
