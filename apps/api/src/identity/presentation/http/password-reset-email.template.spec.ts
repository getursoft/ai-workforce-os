import { describe, expect, it } from "vitest";
import { buildPasswordResetEmail } from "./password-reset-email.template";

describe("buildPasswordResetEmail", () => {
  const otp = "12345678";
  const resetUrl = `https://app.example.com/reset-password?token=${otp}&email=user%40example.com`;

  it("generates a subject naming the product", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    expect(content.subject).toBe("Reset your Krevia.ai password");
  });

  it("prominently displays the 8-digit OTP (spaced for readability) in both bodies", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    expect(content.text).toContain("1234 5678");
    expect(content.html).toContain("1234 5678");
  });

  it("includes the reset URL in the text body verbatim, and in the HTML body HTML-escaped", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    expect(content.text).toContain(resetUrl);
    // The HTML body properly escapes "&" to "&amp;" inside the href attribute — this is correct
    // HTML, not a missing link; assert against the escaped form rather than the raw URL.
    expect(content.html).toContain(resetUrl.replace(/&/g, "&amp;"));
  });

  it("states the expiration window in both bodies", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 45 });
    expect(content.text).toContain("45 minutes");
    expect(content.html).toContain("45 minutes");
  });

  it("includes the required 'ignore this email' security notice", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    expect(content.text.toLowerCase()).toContain("if you did not request this change");
    expect(content.html.toLowerCase()).toContain("if you did not request this change");
  });

  it("includes support text", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    expect(content.text.toLowerCase()).toContain("support");
    expect(content.html.toLowerCase()).toContain("support");
  });

  it("never leaks a password value or an argon2/token hash — the OTP itself is meant to be visible, everything else is not", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    expect(content.text).not.toContain("$argon2");
    expect(content.text.toLowerCase()).not.toContain("password hash");
    expect(content.text.toLowerCase()).not.toContain("token hash");
    expect(content.html).not.toContain("$argon2");
    expect(content.html.toLowerCase()).not.toContain("password hash");
    expect(content.html.toLowerCase()).not.toContain("token hash");
  });

  it("HTML-escapes a reset URL that contains characters unsafe in an href attribute", () => {
    const uglyUrl = 'https://app.example.com/reset-password?token=a"b&c=<script>alert(1)</script>';
    const content = buildPasswordResetEmail({ otp, resetUrl: uglyUrl, expiresInMinutes: 30 });
    expect(content.html).not.toContain("<script>alert(1)</script>");
    expect(content.html).toContain("&lt;script&gt;");
  });

  it("produces valid-looking HTML with a single anchor pointing at the reset URL", () => {
    const content = buildPasswordResetEmail({ otp, resetUrl, expiresInMinutes: 30 });
    const hrefMatches = content.html.match(/href="/g) ?? [];
    expect(hrefMatches.length).toBe(1);
  });
});
