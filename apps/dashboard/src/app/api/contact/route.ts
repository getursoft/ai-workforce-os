import { NextResponse } from "next/server";
import { isValidEmail, isRequired } from "@/lib/validation";
import { API_BASE_URL } from "../../../lib/auth-constants";

interface ContactPayload {
  name: string;
  email: string;
  company: string;
  role: string;
  teamSize: string;
  interest: string;
  message: string;
  preferredContact: string;
}

/**
 * Forwards a validated "Contact Us" submission to the NestJS API's public, unauthenticated platform-lead
 * endpoint (`POST /public/leads`, source CONTACT_US) — the only change from the previous mock handler;
 * the request/response contract exposed to the client is unchanged. Server-to-server only, same as
 * /api/demo — see that route's own doc comment.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as Partial<ContactPayload>;

  const errors: Record<string, string> = {};
  if (!isRequired(body.name ?? "")) errors.name = "Please enter your name.";
  if (!isValidEmail(body.email ?? "")) errors.email = "Please enter a valid business email.";
  if (!isRequired(body.company ?? "")) errors.company = "Please enter your company name.";
  if (!isRequired(body.message ?? "")) errors.message = "Please enter a message.";

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ success: false, errors }, { status: 400 });
  }

  try {
    const response = await fetch(`${API_BASE_URL}/public/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "CONTACT_US",
        name: body.name,
        email: body.email,
        company: body.company,
        requirement: body.message,
        metadata: {
          role: body.role,
          teamSize: body.teamSize,
          interest: body.interest,
          preferredContact: body.preferredContact
        }
      })
    });
    if (!response.ok) {
      return NextResponse.json(
        { success: false, errors: { form: "Something went wrong sending your message. Please try again." } },
        { status: 502 }
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, errors: { form: "Something went wrong sending your message. Please try again." } },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true });
}
