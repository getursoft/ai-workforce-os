import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../lib/api-client";
import { createKnowledgeApi } from "./knowledge-api";

describe("knowledge API", () => {
  it("uses the existing authenticated client for list, upload, re-index and delete", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createKnowledgeApi({ request } as unknown as ApiClient);
    await api.list({ search: "policy", status: "INDEXED" });
    const file = new File(["policy"], "policy.txt", { type: "text/plain" });
    await api.upload(file);
    await api.reindex("doc-1");
    await api.remove("doc-1");
    expect(request.mock.calls[0]?.[0]).toContain(
      "/knowledge/documents?page=1&pageSize=20&search=policy&status=INDEXED"
    );
    const upload = request.mock.calls[1];
    expect(upload?.[0]).toBe("/knowledge/documents");
    expect(upload?.[1]?.body).toBeInstanceOf(FormData);
    expect(request).toHaveBeenCalledWith("/knowledge/documents/doc-1/reindex", {
      method: "POST"
    });
    expect(request).toHaveBeenCalledWith("/knowledge/documents/doc-1", {
      method: "DELETE"
    });
  });
});
