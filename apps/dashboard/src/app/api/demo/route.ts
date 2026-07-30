import { NextResponse } from "next/server";
import { isValidEmail, isRequired } from "@/lib/validation";

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
 * Mock submission endpoint. Swap the body of this handler for a real CRM
 * connection later — the request/response contract stays the same.
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

  await new Promise((resolve) => setTimeout(resolve, 400));

  return NextResponse.json({ success: true });
}
