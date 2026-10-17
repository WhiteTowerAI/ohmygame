import { useEffect, useRef, useState } from "react";
import type {
  ModelAuthEvent,
  ModelAuthMethod,
  ModelAuthNotification,
  ModelAuthPrompt,
} from "../shared/contracts.js";
import {
  cancelModelAuth,
  notifyAgentModelsChanged,
  respondToModelAuth,
  startModelProviderLogin,
  subscribeToModelAuth,
} from "./api.js";
import { t } from "./i18n.js";

export async function openModelAuthExternal(url: string): Promise<void> {
  if (window.ohMyGameDesktop?.openExternal) {
    await window.ohMyGameDesktop.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function externalTarget(notification: ModelAuthNotification | undefined) {
  if (notification?.type === "auth_url") return notification.url;
  if (notification?.type === "device_code") return notification.verificationUri;
  if (notification?.type === "info") return notification.links?.[0]?.url;
  return undefined;
}

/** One daemon-owned authorization flow, shared by Settings and first-run setup. */
export function useModelProviderAuth(options: {
  providerId: string;
  method: ModelAuthMethod;
  onCompleted: () => void;
  onCancelled: () => void;
  onFailed?: (error: string) => void;
}) {
  const [operationId, setOperationId] = useState<string>();
  const [prompt, setPrompt] = useState<{
    id: string;
    value: ModelAuthPrompt;
  }>();
  const [notification, setNotification] = useState<ModelAuthNotification>();
  const [error, setError] = useState<string>();
  const [responding, setResponding] = useState(false);
  const operation = useRef<string | undefined>(undefined);
  const callbacks = useRef(options);
  callbacks.current = options;
  const openedUrl = useRef<string | undefined>(undefined);
  const { providerId, method } = options;

  function fail(message: string) {
    setError(message);
    callbacks.current.onFailed?.(message);
  }

  useEffect(() => {
    let active = true;
    setPrompt(undefined);
    setNotification(undefined);
    setError(undefined);
    setOperationId(undefined);
    openedUrl.current = undefined;
    void startModelProviderLogin(providerId, method)
      .then((id) => {
        if (!active) {
          void cancelModelAuth(id).catch(() => undefined);
          return;
        }
        operation.current = id;
        setOperationId(id);
      })
      .catch((cause) => {
        if (active)
          fail(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
      if (operation.current)
        void cancelModelAuth(operation.current).catch(() => undefined);
      operation.current = undefined;
    };
  }, [providerId, method]);

  useEffect(() => {
    if (!operationId) return;
    let active = true;
    const unsubscribe = subscribeToModelAuth(operationId, {
      onEvent: (event: ModelAuthEvent) => {
        if (!active || operation.current !== operationId) return;
        if (event.type === "notification") setNotification(event.notification);
        else if (event.type === "prompt")
          setPrompt({ id: event.promptId, value: event.prompt });
        else {
          operation.current = undefined;
          setOperationId(undefined);
          if (event.type === "completed") {
            notifyAgentModelsChanged();
            callbacks.current.onCompleted();
          } else if (event.type === "cancelled")
            callbacks.current.onCancelled();
          else if (event.type === "error") fail(event.error);
        }
      },
      onError: () => {
        if (active && operation.current === operationId)
          fail(t("providers.authInterrupted"));
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [operationId]);

  const external = externalTarget(notification);
  useEffect(() => {
    if (method !== "oauth" || !external || openedUrl.current === external)
      return;
    openedUrl.current = external;
    void openModelAuthExternal(external).catch(() => undefined);
  }, [external, method]);

  async function respond(value: string) {
    if (!operation.current || !prompt || responding) return;
    const currentPrompt = prompt;
    setResponding(true);
    setError(undefined);
    try {
      await respondToModelAuth(operation.current, currentPrompt.id, value);
      // Another prompt may arrive over SSE before the response request resolves.
      setPrompt((current) =>
        current?.id === currentPrompt.id ? undefined : current,
      );
    } finally {
      setResponding(false);
    }
  }

  async function cancel() {
    const id = operation.current;
    operation.current = undefined;
    if (id) await cancelModelAuth(id).catch(() => undefined);
    callbacks.current.onCancelled();
  }

  return { prompt, notification, external, error, responding, respond, cancel };
}
