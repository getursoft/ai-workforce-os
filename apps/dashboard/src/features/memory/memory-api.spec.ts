import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client";
import { createMemoryApi } from "./memory-api";

describe("memory API", () => {
  it("lists memories with scope and filter query params", async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const api = createMemoryApi({ request } as unknown as ApiClient);
    await api.list({ scope: "USER", category: "PREFERENCE", search: "airline" }, 2, 50);
    expect(request).toHaveBeenCalledWith(
      "/memory?page=2&pageSize=50&scope=USER&category=PREFERENCE&search=airline"
    );
  });

  it("creates, updates, deletes and searches memories", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createMemoryApi({ request } as unknown as ApiClient);
    await api.create({
      scope: "USER",
      key: "preferred.airline",
      value: { value: "Emirates" },
      category: "PREFERENCE",
      importance: "HIGH"
    });
    await api.update("mem-1", { value: { value: "Vistara" }, importance: "CRITICAL" });
    await api.remove("mem-1");
    await api.search({ query: "airline", employeeId: "emp-1" });
    expect(request).toHaveBeenCalledWith("/memory", {
      method: "POST",
      body: JSON.stringify({
        scope: "USER",
        key: "preferred.airline",
        value: { value: "Emirates" },
        category: "PREFERENCE",
        importance: "HIGH"
      })
    });
    expect(request).toHaveBeenCalledWith("/memory/mem-1", {
      method: "PATCH",
      body: JSON.stringify({ value: { value: "Vistara" }, importance: "CRITICAL" })
    });
    expect(request).toHaveBeenCalledWith("/memory/mem-1", { method: "DELETE" });
    expect(request).toHaveBeenCalledWith("/memory/search", {
      method: "POST",
      body: JSON.stringify({ query: "airline", employeeId: "emp-1" })
    });
  });

  it("summarizes, forgets, merges, expires and reads the audit trail", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createMemoryApi({ request } as unknown as ApiClient);
    await api.summarize("conv-1");
    await api.forget({ scope: "TRAVEL" as never });
    await api.merge(["mem-1", "mem-2"]);
    await api.expire("CONVERSATION");
    await api.audit(3);
    expect(request).toHaveBeenCalledWith("/memory/summarize", {
      method: "POST",
      body: JSON.stringify({ conversationId: "conv-1" })
    });
    expect(request).toHaveBeenCalledWith("/memory/merge", {
      method: "POST",
      body: JSON.stringify({ ids: ["mem-1", "mem-2"] })
    });
    expect(request).toHaveBeenCalledWith("/memory/expire", {
      method: "POST",
      body: JSON.stringify({ scope: "CONVERSATION" })
    });
    expect(request).toHaveBeenCalledWith("/memory/audit?page=3&pageSize=50");
  });
});
