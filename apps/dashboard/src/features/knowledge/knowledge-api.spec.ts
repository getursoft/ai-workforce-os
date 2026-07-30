import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client";
import { createKnowledgeApi } from "./knowledge-api";

describe("knowledge API", () => {
  it("scopes list, upload, re-index and delete to an AI Employee", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createKnowledgeApi({ request } as unknown as ApiClient);
    await api.list("employee-1", { search: "policy", status: "INDEXED" });
    const file = new File(["policy"], "policy.txt", { type: "text/plain" });
    await api.upload("employee-1", "collection-1", file);
    await api.reindex("doc-1");
    await api.remove("doc-1");
    expect(request.mock.calls[0]?.[0]).toContain(
      "/knowledge/employees/employee-1/documents?page=1&pageSize=20&search=policy&status=INDEXED"
    );
    const upload = request.mock.calls[1];
    expect(upload?.[0]).toBe("/knowledge/employees/employee-1/collections/collection-1/documents");
    expect(upload?.[1]?.body).toBeInstanceOf(FormData);
    expect(request).toHaveBeenCalledWith("/knowledge/documents/doc-1/reindex", {
      method: "POST"
    });
    expect(request).toHaveBeenCalledWith("/knowledge/documents/doc-1", {
      method: "DELETE"
    });
  });

  it("manages an employee's knowledge collections", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createKnowledgeApi({ request } as unknown as ApiClient);
    await api.collections.list("employee-1");
    await api.collections.create("employee-1", { name: "Visa Rules" });
    await api.collections.update("collection-1", { name: "Visa Rules v2" });
    await api.collections.remove("collection-1");
    expect(request).toHaveBeenCalledWith("/knowledge/employees/employee-1/collections");
    expect(request).toHaveBeenCalledWith("/knowledge/employees/employee-1/collections", {
      method: "POST",
      body: JSON.stringify({ name: "Visa Rules" })
    });
    expect(request).toHaveBeenCalledWith("/knowledge/collections/collection-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Visa Rules v2" })
    });
    expect(request).toHaveBeenCalledWith("/knowledge/collections/collection-1", {
      method: "DELETE"
    });
  });
});
