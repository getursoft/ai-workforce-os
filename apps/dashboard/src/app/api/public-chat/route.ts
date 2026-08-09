import { NextResponse } from "next/server";
import { knowledgeBase, FALLBACK_ANSWER } from "@/content/chatbot-knowledge";
import { siteConfig } from "@/content/site";
import { chatbotConfig } from "@/lib/chatbot-config";
import { getLocalResponse } from "@/lib/chatbot-local-responder";
import type { PublicChatResponse } from "@/lib/chatbot-types";

export const runtime = "nodejs";

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

interface RequestBody {
  message: string;
  history?: IncomingMessage[];
  pathname?: string;
}

function buildSystemPrompt(pathname: string) {
  const knowledgeSummary = knowledgeBase
    .map((entry) => `- ${entry.answer}`)
    .join("\n");

  return `You are the Krevia.ai public website assistant. Krevia.ai is "${siteConfig.tagline}" — ${siteConfig.description}

The visitor is currently on the page: ${pathname || "/"}

Ground every answer strictly in the confirmed information below. Do not invent capabilities, integrations, pricing figures or certifications.
${knowledgeSummary}

Rules:
- Keep answers concise: 2 to 4 sentences, plain business language, no markdown formatting.
- Never claim the platform is SOC 2, ISO 27001 or GDPR certified — only that it is "designed to support enterprise security requirements".
- Never claim AI employees replace humans, operate fully autonomously without oversight, or guarantee savings.
- Position AI employees as collaborators that support and extend human teams.
- If the question is unrelated to Krevia.ai or not covered by the information above, reply with exactly: "${FALLBACK_ANSWER}"`;
}

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: FALLBACK_ANSWER } satisfies PublicChatResponse, { status: 400 });
  }

  const message = (body.message ?? "").toString().slice(0, 2000);
  const pathname = body.pathname ?? "/";
  const history = Array.isArray(body.history) ? body.history.slice(-chatbotConfig.maxHistoryMessages) : [];

  const localFallback = getLocalResponse(message);
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return NextResponse.json(localFallback satisfies PublicChatResponse);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), chatbotConfig.requestTimeoutMs);

  try {
    const response = await fetch(chatbotConfig.openRouterEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": `https://${siteConfig.domain}`,
        "X-Title": siteConfig.name,
      },
      body: JSON.stringify({
        model: chatbotConfig.openRouterModel,
        messages: [
          { role: "system", content: buildSystemPrompt(pathname) },
          ...history.map((entry) => ({ role: entry.role, content: entry.content })),
          { role: "user", content: message },
        ],
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return NextResponse.json(localFallback satisfies PublicChatResponse);
    }

    const data = await response.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content?.trim();

    if (!text) {
      return NextResponse.json(localFallback satisfies PublicChatResponse);
    }

    const result: PublicChatResponse = {
      message: text,
      actions: localFallback.actions,
      relatedQuestions: localFallback.relatedQuestions,
    };

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(localFallback satisfies PublicChatResponse);
  } finally {
    clearTimeout(timeout);
  }
}
