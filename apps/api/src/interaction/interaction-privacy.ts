/** Sprint 7.12 STEP 30 — destination masking for InteractionNotification.destinationMasked. Distinct
 * from voice-call-history.service.ts's `maskCallerId` (which fully masks except the last 4 digits, no
 * country code) — here the brief's own examples keep the country code visible
 * (`+91******1193`), a different UX for a notification-destination display than a caller-id column, so a
 * fresh, purpose-built masker is used rather than forcing one shared implementation to fit both. */

export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  const last4 = trimmed.slice(-4);
  if (trimmed.length <= 7) return `${"*".repeat(Math.max(trimmed.length - 4, 1))}${last4}`;
  // Best-effort: keep a short "+NN"-shaped prefix visible when E.164-shaped, matching the brief's own
  // "+91******1193" example — this is a display convenience, not a real per-country-code-length lookup.
  const prefix = trimmed.startsWith("+") ? trimmed.slice(0, 3) : "";
  const middleLength = trimmed.length - prefix.length - last4.length;
  return `${prefix}${"*".repeat(Math.max(middleLength, 1))}${last4}`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  const maskLength = Math.max(local.length - visible.length, 3);
  return `${visible}${"*".repeat(maskLength)}@${domain}`;
}
