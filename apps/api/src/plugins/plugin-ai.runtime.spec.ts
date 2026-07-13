import { describe, expect, it, vi } from "vitest";
import { AzureOpenAiProvider, OpenAiCompatibleProvider, SafeHttpTool } from "./plugin-ai.runtime";
const request = { messages: [{ role: "user" as const, content: "hello" }] };
describe("AI provider adapters", () => {
  it("maps OpenAI-compatible requests and responses", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer private-key" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "configured-model" });
      return new Response(
        JSON.stringify({
          model: "configured-model",
          choices: [{ message: { content: "ok", tool_calls: [] } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        }),
        { status: 200 }
      );
    });
    const result = await new OpenAiCompatibleProvider(
      { providerType: "OPENAI_COMPATIBLE", model: "configured-model", timeoutMs: 1000 },
      "private-key",
      fetcher
    ).complete(request);
    expect(result).toMatchObject({
      content: "ok",
      provider: "openai-compatible",
      usage: { totalTokens: 3 }
    });
  });
  it("maps Azure deployment and credentials", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/deployments/travel/chat/completions?api-version=2025-01-01");
      expect(init?.headers).toMatchObject({ "api-key": "secret" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      });
    });
    await new AzureOpenAiProvider(
      {
        providerType: "AZURE_OPENAI",
        endpoint: "https://example.openai.azure.com",
        deploymentName: "travel",
        apiVersion: "2025-01-01",
        timeoutMs: 1000
      },
      "secret",
      fetcher
    ).complete(request);
  });
  it("normalizes upstream failures without leaking secrets", async () => {
    const provider = new OpenAiCompatibleProvider(
      { providerType: "OPENAI_COMPATIBLE", model: "m", timeoutMs: 1000 },
      "do-not-leak",
      async () => new Response("do-not-leak", { status: 500 })
    );
    await expect(provider.complete(request)).rejects.toThrow("AI_PROVIDER_UNAVAILABLE");
  });
});
describe("SafeHttpTool", () => {
  it.each(["http://localhost/x", "http://127.0.0.1/x", "http://[::1]/x", "ftp://example.com/x"])(
    "blocks unsafe destination %s",
    async (url) => {
      await expect(
        new SafeHttpTool(vi.fn(), async () => ["93.184.216.34"]).execute({ method: "GET", url })
      ).rejects.toThrow("HTTP_DESTINATION_BLOCKED");
    }
  );
  it("blocks private and metadata DNS results", async () => {
    for (const address of ["10.0.0.1", "192.168.1.2", "169.254.169.254"])
      await expect(
        new SafeHttpTool(vi.fn(), async () => [address]).execute({
          method: "GET",
          url: "https://public.example/x"
        })
      ).rejects.toThrow("HTTP_DESTINATION_BLOCKED");
  });
  it("rejects dangerous headers and redirect SSRF", async () => {
    const tool = new SafeHttpTool(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://localhost/admin" } }),
      async () => ["93.184.216.34"]
    );
    await expect(
      tool.execute({
        method: "GET",
        url: "https://safe.example",
        headers: { Authorization: "secret" }
      })
    ).rejects.toThrow("HTTP_HEADER_BLOCKED");
    await expect(tool.execute({ method: "GET", url: "https://safe.example" })).rejects.toThrow(
      "HTTP_DESTINATION_BLOCKED"
    );
  });
  it("allows public HTTPS and enforces response size", async () => {
    const resolver = async () => ["93.184.216.34"];
    await expect(
      new SafeHttpTool(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" }
          }),
        resolver
      ).execute({ method: "GET", url: "https://safe.example" })
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(
      new SafeHttpTool(async () => new Response("x".repeat(256001)), resolver).execute({
        method: "GET",
        url: "https://safe.example"
      })
    ).rejects.toThrow("HTTP_RESPONSE_TOO_LARGE");
  });
});
