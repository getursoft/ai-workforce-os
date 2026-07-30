import { describe, expect, it } from "vitest";
import { isExplicitBookingConfirmation } from "./booking-confirmation";

describe("isExplicitBookingConfirmation", () => {
  it.each(["yes", "Yes please", "confirm", "confirmed", "go ahead", "please proceed", "sure", "ok", "okay"])(
    "treats %j as an explicit confirmation",
    (text) => {
      expect(isExplicitBookingConfirmation(text)).toBe(true);
    }
  );

  it.each(["no", "not now", "don't proceed", "do not save it", "maybe later", "what does that mean?"])(
    "does not treat %j as an explicit confirmation",
    (text) => {
      expect(isExplicitBookingConfirmation(text)).toBe(false);
    }
  );
});
