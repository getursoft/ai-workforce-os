/** Sprint 7.12 STEP 20/46/47/48 — reference notification templates. No existing template-rendering
 * infrastructure was found to reuse (inspection confirmed), so these are small, pure, testable render
 * functions — no secrets are ever interpolated into any of them. */

export interface ReferenceTemplateInput {
  referenceId: string;
  organizationName: string;
  customerName?: string | null;
  interactionSummary?: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

/** REFERENCE_EMAIL */
export function renderReferenceEmail(input: ReferenceTemplateInput): RenderedEmail {
  const greeting = input.customerName ? `Hi ${input.customerName},` : "Hi,";
  const summary = input.interactionSummary ? `\n\nSummary: ${input.interactionSummary}` : "";
  return {
    subject: `Your ${input.organizationName} reference — ${input.referenceId}`,
    text:
      `${greeting}\n\n` +
      `Thanks for reaching out to ${input.organizationName}. We've saved your request under the ` +
      `reference below.\n\n` +
      `Reference: ${input.referenceId}\n\n` +
      `If you need to follow up, just share this reference and we'll pick up right where we left ` +
      `off.${summary}\n\n` +
      `— ${input.organizationName}`
  };
}

/** REFERENCE_SMS — kept short (SMS length conventions). */
export function renderReferenceSms(input: ReferenceTemplateInput): string {
  return `${input.organizationName}: Your interaction reference is ${input.referenceId}. Keep this ID for future follow-up.`;
}

/** REFERENCE_WHATSAPP — natural, not robotic. */
export function renderReferenceWhatsApp(input: ReferenceTemplateInput): string {
  return (
    `Your request has been saved.\n` +
    `Reference: ${input.referenceId}\n\n` +
    `Share this reference whenever you'd like to continue.`
  );
}
