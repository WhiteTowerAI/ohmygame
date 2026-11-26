// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInDialog } from "../src/renderer/sign-in-dialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("sign-in dialog email code", () => {
  it("sends a code, then signs in with it", async () => {
    const onSendEmailCode = vi.fn(async () => true);
    const onVerifyEmailCode = vi.fn(async () => {});
    render({ onSendEmailCode, onVerifyEmailCode });

    await type(input("email"), " di@example.com ");
    await click(button("Send code"));

    expect(onSendEmailCode).toHaveBeenCalledWith("di@example.com");
    expect(document.body.textContent).toContain("Enter the code we sent to di@example.com.");
    expect(button("Resend in 60s").disabled).toBe(true);

    await type(input("numeric"), "12a3456");
    expect(input("numeric").value).toBe("123456");
    await click(button("Sign in"));

    expect(onVerifyEmailCode).toHaveBeenCalledWith("di@example.com", "123456");
  });

  it("stays on the email step when sending fails", async () => {
    render({ onSendEmailCode: vi.fn(async () => false), error: "Email rate limit exceeded" });

    await type(input("email"), "di@example.com");
    await click(button("Send code"));

    expect(document.querySelector("input[type='email']")).not.toBeNull();
    expect(document.body.textContent).toContain("Email rate limit exceeded");
  });

  it("returns to the email step to use a different address", async () => {
    render({});

    await type(input("email"), "di@example.com");
    await click(button("Send code"));
    await click(button("Use a different email"));

    expect(input("email").value).toBe("di@example.com");
  });

  it("disables email sign-in while an OAuth sign-in is pending", () => {
    render({ pendingProvider: "google" });

    expect(input("email").disabled).toBe(true);
  });
});

function render(props: Partial<Parameters<typeof SignInDialog>[0]>): void {
  root = createRoot(document.createElement("div"));
  act(() => root!.render(
    <SignInDialog
      configured
      onClose={vi.fn()}
      onSignIn={vi.fn()}
      onSendEmailCode={vi.fn(async () => true)}
      onVerifyEmailCode={vi.fn(async () => {})}
      {...props}
    />,
  ));
}

function input(kind: "email" | "numeric"): HTMLInputElement {
  const selector = kind === "email" ? "input[type='email']" : "input[inputmode='numeric']";
  const element = document.querySelector<HTMLInputElement>(selector);
  if (!element) throw new Error(`Missing ${kind} input`);
  return element;
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}

async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}
