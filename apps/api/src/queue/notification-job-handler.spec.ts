import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationJobHandler } from "./notification-job-handler";
import { QueueMessageView } from "./queue.types";

describe("NotificationJobHandler", () => {
  let handler: NotificationJobHandler;
  let mockOrchestrator: { notifyReferenceIssued: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockOrchestrator = {
      notifyReferenceIssued: vi.fn().mockResolvedValue(undefined)
    };
    const registry = { register: vi.fn(), resolve: vi.fn() };
    handler = new NotificationJobHandler(mockOrchestrator as any, registry as any);
  });

  function makeMessage(): QueueMessageView {
    return {
      id: "msg-1",
      organizationId: "org-1",
      category: "NOTIFICATION_JOBS" as any,
      refType: "Interaction",
      refId: "interaction-1",
      employeeId: null,
      priority: 0,
      status: "CLAIMED",
      payload: { interactionId: "interaction-1", organizationId: "org-1" },
      availableAt: new Date(),
      attemptCount: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      workerId: null,
      traceId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date()
    };
  }

  it("should call notifyReferenceIssued with correct organizationId and interactionId", async () => {
    const result = await handler.handle(makeMessage());
    expect(result).toBe(true);
    expect(mockOrchestrator.notifyReferenceIssued).toHaveBeenCalledWith("org-1", "interaction-1");
  });

  it("should return true when orchestrator succeeds", async () => {
    const result = await handler.handle(makeMessage());
    expect(result).toBe(true);
  });

  it("should return false when orchestrator throws", async () => {
    mockOrchestrator.notifyReferenceIssued.mockRejectedValue(new Error("DB down"));
    const result = await handler.handle(makeMessage());
    expect(result).toBe(false);
  });

  it("should return true for missing payload fields", async () => {
    const msg = { ...makeMessage(), payload: {} };
    const result = await handler.handle(msg);
    expect(result).toBe(true);
    expect(mockOrchestrator.notifyReferenceIssued).not.toHaveBeenCalled();
  });
});
