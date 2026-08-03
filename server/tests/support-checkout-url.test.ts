/**
 * The Support ("pay what you can") button must point at an endpoint that exists.
 *
 * Production, 2026-08-03 11:34:16Z: `support_checkout_upstream_error status 404`,
 * surfaced to the player as a 502 from /api/support/checkout. The default
 * upstream was `https://multiversestudios.xyz/stripe/create-checkout-session`,
 * which returns an nginx 404 — that host does not route /stripe at all. Verified
 * by hand from the games box; `https://pay.multiversegames.ai/create-checkout-session`
 * with this app's own game key returns 200 and a real Stripe checkout URL.
 *
 * docs/analytics/REVIEW-2026-08-02.md reaches the same conclusion from the other
 * direction: "0 checkouts in 30d" was an outage, not player behaviour. This test
 * exists so a dead host cannot be shipped as the default again.
 */
import { describe, it, expect } from "vitest";
import { getCheckoutUrl, DEAD_CHECKOUT_HOSTS } from "../src/routes/support.js";

describe("support checkout endpoint", () => {
  it("does not default to a host known to 404", () => {
    const url = getCheckoutUrl();
    for (const deadHost of DEAD_CHECKOUT_HOSTS) {
      expect(
        url.includes(deadHost),
        `checkout defaults to ${url}, whose host ${deadHost} returns an nginx 404 — ` +
          "every Support click becomes a 502 for the player",
      ).toBe(false);
    }
  });

  it("points at the live checkout host", () => {
    expect(getCheckoutUrl()).toContain("pay.multiversegames.ai");
  });

  it("targets the create-checkout-session path", () => {
    expect(getCheckoutUrl()).toMatch(/\/create-checkout-session$/);
  });

  it("is an absolute https URL", () => {
    const url = getCheckoutUrl();
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).protocol).toBe("https:");
  });
});
