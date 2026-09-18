import { describe, expect, it } from "vitest";
import { paymentUrl } from "../src/shared/account.js";

describe("account API", () => {
  it("only opens Stripe hosted payment URLs", () => {
    expect(paymentUrl("https://checkout.stripe.com/c/pay/cs_test")).toContain("checkout.stripe.com");
    expect(() => paymentUrl("https://stripe.example/checkout")).toThrow("Invalid payment URL");
    expect(() => paymentUrl("javascript:alert(1)")).toThrow("Invalid payment URL");
  });
});
