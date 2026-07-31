import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  EmailConfigurationForm,
  buildEmailConfigurationPayload,
  emailConfigurationErrorMessage,
  shouldClearPasswordAfterSave
} from "./email-configuration-form";
import type { EmailConfiguration } from "./plugin-api";

const CONFIGURED: EmailConfiguration = {
  pluginInstallationId: "plugin-1",
  configured: true,
  configuration: {
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "sender@example.com",
    fromEmail: "sender@example.com",
    fromName: "Travel Desk"
  },
  secrets: { password: { configured: true, updatedAt: "2026-07-31T00:00:00.000Z" } },
  updatedAt: "2026-07-31T00:00:00.000Z"
};

const NOT_CONFIGURED: EmailConfiguration = {
  pluginInstallationId: "plugin-1",
  configured: false,
  configuration: {},
  secrets: { password: { configured: false, updatedAt: null } },
  updatedAt: null
};

describe("buildEmailConfigurationPayload", () => {
  it("requires a sender email once an SMTP host is set", () => {
    const result = buildEmailConfigurationPayload({
      smtpHost: "smtp.example.com",
      smtpPort: "",
      smtpSecure: false,
      smtpUser: "",
      fromEmail: "",
      fromName: "",
      password: "",
      removePassword: false
    });
    expect(result.errors.fromEmail).toBeTruthy();
    expect(result.payload).toBeUndefined();
  });

  it("rejects an invalid sender email", () => {
    const result = buildEmailConfigurationPayload({
      smtpHost: "smtp.example.com",
      smtpPort: "",
      smtpSecure: false,
      smtpUser: "",
      fromEmail: "not-an-email",
      fromName: "",
      password: "",
      removePassword: false
    });
    expect(result.errors.fromEmail).toBeTruthy();
  });

  it("rejects an out-of-range port", () => {
    const result = buildEmailConfigurationPayload({
      smtpHost: "smtp.example.com",
      smtpPort: "70000",
      smtpSecure: false,
      smtpUser: "",
      fromEmail: "sender@example.com",
      fromName: "",
      password: "",
      removePassword: false
    });
    expect(result.errors.smtpPort).toBeTruthy();
  });

  it("builds a valid payload with the password only when provided", () => {
    const result = buildEmailConfigurationPayload({
      smtpHost: "smtp.example.com",
      smtpPort: "465",
      smtpSecure: true,
      smtpUser: "sender@example.com",
      fromEmail: "sender@example.com",
      fromName: "Travel Desk",
      password: "secret",
      removePassword: false
    });
    expect(result.errors).toEqual({});
    expect(result.payload).toMatchObject({
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      fromEmail: "sender@example.com",
      secrets: { password: "secret" }
    });
  });

  it("sends removeSecrets instead of a password when removePassword is checked", () => {
    const result = buildEmailConfigurationPayload({
      smtpHost: "smtp.example.com",
      smtpPort: "",
      smtpSecure: false,
      smtpUser: "",
      fromEmail: "sender@example.com",
      fromName: "",
      password: "ignored-because-removing",
      removePassword: true
    });
    expect(result.payload?.removeSecrets).toEqual(["password"]);
    expect(result.payload?.secrets).toBeUndefined();
  });

  it("allows clearing every field back to empty (no host at all)", () => {
    const result = buildEmailConfigurationPayload({
      smtpHost: "",
      smtpPort: "",
      smtpSecure: false,
      smtpUser: "",
      fromEmail: "",
      fromName: "",
      password: "",
      removePassword: false
    });
    expect(result.errors).toEqual({});
    expect(result.payload).toEqual({ smtpSecure: false });
  });
});

describe("shouldClearPasswordAfterSave", () => {
  it("clears the password field only after a successful save", () => {
    expect(shouldClearPasswordAfterSave(true)).toBe(true);
    expect(shouldClearPasswordAfterSave(false)).toBe(false);
  });
});

describe("emailConfigurationErrorMessage", () => {
  it("maps a known error code to a specific message", () => {
    expect(emailConfigurationErrorMessage({ code: "EMAIL_CONFIGURATION_INVALID" })).toMatch(/SMTP host/);
  });
  it("falls back to a generic message for unknown codes", () => {
    expect(emailConfigurationErrorMessage({ code: "SOMETHING_ELSE" })).toMatch(/fields and try again/);
  });
});

describe("EmailConfigurationForm", () => {
  it("shows the stored settings and a 'configured' placeholder for the password, never the password itself", () => {
    const html = renderToStaticMarkup(
      <EmailConfigurationForm
        configuration={CONFIGURED}
        canManage
        saving={false}
        save={vi.fn()}
        saveError={null}
        saveSucceeded={false}
      />
    );
    expect(html).toContain("smtp.example.com");
    expect(html).toContain("sender@example.com");
    expect(html).toContain("Travel Desk");
    expect(html).toContain("Leave blank to keep the stored password");
    expect(html).not.toContain("super-secret");
  });

  it("shows a 'not configured' placeholder and hides the remove-password checkbox when nothing is saved yet", () => {
    const html = renderToStaticMarkup(
      <EmailConfigurationForm
        configuration={NOT_CONFIGURED}
        canManage
        saving={false}
        save={vi.fn()}
        saveError={null}
        saveSucceeded={false}
      />
    );
    expect(html).toContain("Not configured.");
    expect(html).not.toContain("I confirm removal of the stored SMTP");
  });

  it("disables every field and hides the save button when the viewer cannot manage settings", () => {
    const html = renderToStaticMarkup(
      <EmailConfigurationForm
        configuration={CONFIGURED}
        canManage={false}
        saving={false}
        save={vi.fn()}
        saveError={null}
        saveSucceeded={false}
      />
    );
    expect(html).toContain("Only organization Owners and Admins");
    expect(html).not.toContain("Save email settings");
  });
});
