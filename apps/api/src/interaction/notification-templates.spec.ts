import { describe, expect, it } from "vitest";
import { renderReferenceEmail, renderReferenceSms, renderReferenceWhatsApp } from "./notification-templates";

const base = { referenceId: "KRV-842731", organizationName: "Krevia" };

describe("notification templates (Sprint 7.12 STEP 20/46/47/48)", () => {
  it("renders the reference email with subject and reference id, no customer-name assumption", () => {
    const email = renderReferenceEmail(base);
    expect(email.subject).toBe("Your Krevia reference — KRV-842731");
    expect(email.text).toContain("KRV-842731");
    expect(email.text).toContain("Hi,");
  });

  it("greets by name when provided", () => {
    const email = renderReferenceEmail({ ...base, customerName: "Asha" });
    expect(email.text).toContain("Hi Asha,");
  });

  it("includes an interaction summary when provided", () => {
    const email = renderReferenceEmail({ ...base, interactionSummary: "Dubai trip, 2 adults" });
    expect(email.text).toContain("Dubai trip, 2 adults");
  });

  it("renders a short SMS with the org name and reference", () => {
    const sms = renderReferenceSms(base);
    expect(sms).toContain("Krevia");
    expect(sms).toContain("KRV-842731");
    expect(sms.length).toBeLessThan(160);
  });

  it("renders a natural WhatsApp message with the reference on its own line", () => {
    const whatsapp = renderReferenceWhatsApp(base);
    expect(whatsapp).toContain("Reference: KRV-842731");
  });
});
