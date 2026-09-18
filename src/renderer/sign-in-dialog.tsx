import { LoaderCircle, X } from "./icons.js";
import { useEffect, useRef } from "react";

export type SignInProvider = "google" | "github";

interface SignInDialogProps {
  allowClose?: boolean;
  configured: boolean;
  error?: string;
  pendingProvider?: SignInProvider;
  onClose: () => void;
  onSignIn: (provider: SignInProvider) => void;
}

export function SignInDialog({ allowClose = false, configured, error, pendingProvider, onClose, onSignIn }: SignInDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const allowCloseRef = useRef(allowClose);
  const pendingProviderRef = useRef(pendingProvider);
  onCloseRef.current = onClose;
  allowCloseRef.current = allowClose;
  pendingProviderRef.current = pendingProvider;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (!pendingProviderRef.current || allowCloseRef.current)) {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="sign-in-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && (!pendingProvider || allowClose)) onClose();
    }}>
      <section ref={dialog} className="sign-in-dialog" role="dialog" aria-modal="true" aria-labelledby="sign-in-title" tabIndex={-1}>
        <button className="sign-in-close" type="button" onClick={onClose} disabled={Boolean(pendingProvider) && !allowClose} aria-label="Close sign in">
          <X size={16} />
        </button>
        <h2 id="sign-in-title">Sign in to OhMyGame</h2>
        <p>Keep your OhMyGame identity across devices.</p>
        <div className="sign-in-actions">
          <ProviderButton provider="google" pendingProvider={pendingProvider} onSignIn={onSignIn} />
          <ProviderButton provider="github" pendingProvider={pendingProvider} onSignIn={onSignIn} />
        </div>
        {!configured && !error ? <p className="sign-in-error" role="alert">Supabase Auth is not configured.</p> : null}
        {error ? <p className="sign-in-error" role="alert">{error}</p> : null}
        <p className="sign-in-note">Coding and Explore browsing remain available without signing in.</p>
      </section>
    </div>
  );
}

function ProviderButton({ provider, pendingProvider, onSignIn }: {
  provider: SignInProvider;
  pendingProvider?: SignInProvider;
  onSignIn: (provider: SignInProvider) => void;
}) {
  const pending = pendingProvider === provider;
  return (
    <button className="sign-in-provider" type="button" disabled={Boolean(pendingProvider)} onClick={() => onSignIn(provider)}>
      {pending ? <LoaderCircle className="spin" size={18} /> : provider === "google" ? <GoogleIcon /> : <GitHubIcon />}
      Continue with {provider === "google" ? "Google" : "GitHub"}
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285f4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.614Z" />
      <path fill="#34a853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#fbbc05" d="M3.963 10.706A5.414 5.414 0 0 1 3.682 9c0-.592.102-1.167.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.332Z" />
      <path fill="#ea4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.463.892 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.02c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.04 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.71 5.38-5.29 5.67.42.36.79 1.06.79 2.14v3.18c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
