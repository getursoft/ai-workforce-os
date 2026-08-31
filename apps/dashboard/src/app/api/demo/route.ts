import { NextResponse } from "next/server";
import { isValidEmail, isRequired } from "@/lib/validation";
import { API_BASE_URL } from "../../../lib/auth-constants";

interface DemoPayload {
  fullName: string;
  email: string;
  company: string;
  jobTitle: string;
  phone: string;
  companySize: string;
  department: string;
  useCase: string;
  employeeCount: string;
  integrationNeeds: string;
  preferredDate: string;
  message: string;
}

/**
 * Forwards a validated "Book a Demo" submission to the NestJS API's public, unauthenticated platform-lead
 * endpoint (`POST /public/leads`, source WEBSITE_DEMO) — this is the only thing that changed from the
 * previous mock handler; the request/response contract this route exposes to the client is unchanged.
 * Server-to-server only: the browser never talks to the NestJS API directly for this, and never supplies
 * (or could supply) tenant ownership — see PlatformLeadsPublicController's own doc comment.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as Partial<DemoPayload>;

  const errors: Record<string, string> = {};
  if (!isRequired(body.fullName ?? "")) errors.fullName = "Please enter your full name.";
  if (!isValidEmail(body.email ?? "")) errors.email = "Please enter a valid business email.";
  if (!isRequired(body.company ?? "")) errors.company = "Please enter your company name.";
  if (!isRequired(body.jobTitle ?? "")) errors.jobTitle = "Please enter your job title.";
  if (!isRequired(body.companySize ?? "")) errors.companySize = "Please select your company size.";
  if (!isRequired(body.department ?? "")) errors.department = "Please select a department.";
  if (!isRequired(body.useCase ?? "")) errors.useCase = "Please describe your primary use case.";

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ success: false, errors }, { status: 400 });
  }

  try {
    const response = await fetch(`${API_BASE_URL}/public/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "WEBSITE_DEMO",
        name: body.fullName,
        email: body.email,
        phone: body.phone || undefined,
        company: body.company,
        requirement: body.message || body.useCase || undefined,
        preferredDemoDate: body.preferredDate || undefined,
        metadata: {
          jobTitle: body.jobTitle,
          companySize: body.companySize,
          department: body.department,
          useCase: body.useCase,
          employeeCount: body.employeeCount,
          integrationNeeds: body.integrationNeeds
        }
      })
    });
    if (!response.ok) {
      return NextResponse.json(
        { success: false, errors: { form: "Something went wrong submitting your request. Please try again." } },
        { status: 502 }
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, errors: { form: "Something went wrong submitting your request. Please try again." } },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true });
}
