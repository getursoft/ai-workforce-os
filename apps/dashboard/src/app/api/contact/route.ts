import { NextResponse } from "next/server";
import { isValidEmail, isRequired } from "@/lib/validation";

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
 * Mock submission endpoint. Swap the body of this handler for a real CRM or
 * ticketing integration later — the request/response contract stays the same.
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

  await new Promise((resolve) => setTimeout(resolve, 400));

  return NextResponse.json({ success: true });
}
