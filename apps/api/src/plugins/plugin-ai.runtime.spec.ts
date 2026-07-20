import { describe, expect, it, vi } from "vitest";
import {
  AiProviderError,
  AzureOpenAiProvider,
  DeterministicTravelProvider,
  OpenAiCompatibleProvider,
  SafeHttpTool,
  createAiProvider
} from "./plugin-ai.runtime";
const request = { messages: [{ role: "user" as const, content: "hello" }] };
describe("AI provider adapters", () => {
  it("maps OpenAI-compatible requests and responses", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer private-key" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "configured-model",
        tools: [
          {
            type: "function",
            function: { name: "platform_dmemory_dsave" }
          }
        ]
      });
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
    ).complete({
      ...request,
      tools: [
        {
          name: "platform.memory.save",
          description: "Save memory",
          inputSchema: { type: "object" }
        }
      ]
    });
    expect(result).toMatchObject({
      content: "ok",
      provider: "openai-compatible",
      usage: { totalTokens: 3 }
    });
  });
  it("rejects a malformed successful upstream response", async () => {
    const provider = new OpenAiCompatibleProvider(
      { providerType: "OPENAI_COMPATIBLE", model: "m", timeoutMs: 1000 },
      "secret",
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })
    );
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_RESPONSE_INVALID",
      stage: "response_parse"
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
  it.each([
    [401, "AI_PROVIDER_AUTHENTICATION_FAILED"],
    [404, "AI_PROVIDER_MODEL_NOT_FOUND"],
    [429, "AI_PROVIDER_QUOTA_EXCEEDED"]
  ])("maps upstream status %s to %s", async (status, code) => {
    const provider = new OpenAiCompatibleProvider(
      { providerType: "OPENAI_COMPATIBLE", model: "m", timeoutMs: 1000 },
      "secret",
      async () => new Response(null, { status })
    );
    await expect(provider.complete(request)).rejects.toMatchObject({
      code,
      upstreamStatus: status
    });
  });
  it("maps provider timeouts to unavailable", async () => {
    const provider = new OpenAiCompatibleProvider(
      { providerType: "OPENAI_COMPATIBLE", model: "m", timeoutMs: 5 },
      "secret",
      () => new Promise<Response>(() => undefined)
    );
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE"
    });
  });
  it("selects the configured OpenAI adapter without deterministic fallback", () => {
    expect(
      createAiProvider({ providerType: "OPENAI_COMPATIBLE", model: "m", timeoutMs: 1000 }, "secret")
    ).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(
      createAiProvider({ providerType: "DETERMINISTIC", timeoutMs: 1000 }, undefined)
    ).toBeInstanceOf(DeterministicTravelProvider);
    expect(() =>
      createAiProvider({ providerType: "UNKNOWN" as never, model: "m", timeoutMs: 1000 }, "secret")
    ).toThrow(AiProviderError);
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
