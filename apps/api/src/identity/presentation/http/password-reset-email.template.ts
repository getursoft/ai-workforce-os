/**
 * Pure, deterministic builder for the "forgot password" email. Kept separate from the controller so
 * its content can be unit-tested without a real (or mocked) SMTP transport. The 8-digit OTP is the
 * primary UX element (shown prominently, meant to be read and typed in) — this is a deliberate
 * departure from a long-opaque-token-in-a-link design toward a standard numeric-OTP flow. The reset
 * link is still included as a convenience (it prefills the code on click) but is not the only path.
 */
export interface PasswordResetEmailInput {
  otp: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface PasswordResetEmailContent {
  subject: string;
  text: string;
  html: string;
}

const BRAND = "Krevia.ai";

export function buildPasswordResetEmail(input: PasswordResetEmailInput): PasswordResetEmailContent {
  const subject = `Reset your ${BRAND} password`;
  const spacedOtp = input.otp.replace(/(\d{4})(\d{4})/, "$1 $2");
  const text = [
    `${BRAND} — Reset your password`,
    "",
    "We received a request to reset the password for your account.",
    "",
    `Your password reset code: ${spacedOtp}`,
    "",
    `Or open this link, which fills the code in for you: ${input.resetUrl}`,
    "",
    `This code expires in ${input.expiresInMinutes} minutes and can only be used once.`,
    "",
    "If you did not request this change, you can ignore this email — your password will not be changed.",
    "",
    `Need help? Contact your workspace administrator or ${BRAND} support.`
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,0.1);">
            <tr>
              <td style="padding:32px 32px 0 32px;">
                <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6366f1;">${escapeHtml(BRAND)}</p>
                <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;color:#111827;">Reset your password</h1>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#374151;">
                  We received a request to reset the password for your account. Enter the code below, or click the link to have it filled in for you.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 8px 32px;">
                <div style="display:inline-block;background-color:#eef2ff;border-radius:10px;padding:16px 28px;">
                  <span style="font-family:'SF Mono',Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#4338ca;">${escapeHtml(spacedOtp)}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 32px 24px 32px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
                  This code expires in <strong>${input.expiresInMinutes} minutes</strong> and can only be used once.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <a href="${escapeAttribute(input.resetUrl)}"
                   style="display:inline-block;background-color:#4f46e5;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">
                  Reset Password
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;border-top:1px solid #e5e7eb;">
                <p style="margin:20px 0 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
                  If you did not request this change, you can safely ignore this email — your password will not be changed.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  Need help? Contact your workspace administrator or ${escapeHtml(BRAND)} support.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Attribute context needs the same escaping as text content here — no `javascript:`/quote-breakout
 *  risk beyond that since `resetUrl` is always server-constructed from `webAppUrl` + a random token,
 *  never from user input. */
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
