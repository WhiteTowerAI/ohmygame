import { useEffect, useState, type FormEvent } from "react";
import type {
  AccountRuntimeId,
  AgentAccountProfileStatus,
} from "../shared/agent-runtimes.js";
import {
  addAccountProfile,
  deleteAccountProfile,
  listAccountProfiles,
} from "./api.js";
import { AgentUsageInline } from "./agent-usage.js";
import { ChevronDown, RotateCcw, Plus, RefreshCw, Trash2, X } from "./icons.js";
import { t } from "./i18n.js";

/** Named references to CLI-owned configuration directories, with the CLI's own sign-in flow. */
export function AgentAccountProfiles({
  runtime,
  defaultProfileId,
  onDefault,
  onLogin,
  onRemoved,
  disabled,
}: {
  runtime: AccountRuntimeId;
  defaultProfileId: string;
  onDefault: (id: string) => Promise<void>;
  onLogin: (id: string) => Promise<void>;
  onRemoved: () => Promise<void>;
  disabled: boolean;
}) {
  const [profiles, setProfiles] = useState<AgentAccountProfileStatus[]>([]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<AgentAccountProfileStatus>();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [working, setWorking] = useState(false);
  const busy = working || disabled;
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    const load = () =>
      void listAccountProfiles(runtime)
        .then((profiles) => {
          if (!disposed) setProfiles(profiles);
        })
        .catch((cause) => {
          if (!disposed) setError(String(cause));
        });
    load();
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      window.removeEventListener("focus", load);
    };
  }, [runtime]);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setWorking(true);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }
  function add(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const profile = await addAccountProfile(
        runtime,
        name.trim(),
        directory.trim() || undefined,
      );
      setProfiles((current) => [
        ...current,
        {
          ...profile,
          auth: {
            status: directory.trim() ? "unknown" : "signed-out",
            billing: "unknown",
          },
        },
      ]);
      setAdding(false);
      setName("");
      setDirectory("");
      if (directory.trim()) setProfiles(await listAccountProfiles(runtime));
      else await onLogin(profile.id);
    });
  }
  return (
    <section className="settings-detail-section provider-models agent-account-profiles">
      <div className="provider-models-heading">
        <h4>{t("codingAgents.profiles")}</h4>
        <div className="provider-models-heading-actions">
          <button
            className="icon-button settings-provider-setting-edit"
            type="button"
            aria-label={t("codingAgents.profileRecheck")}
            title={t("codingAgents.profileRecheck")}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setProfiles(await listAccountProfiles(runtime, true));
              })
            }
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="icon-button settings-provider-setting-edit"
            type="button"
            aria-label={t(adding ? "common.cancel" : "codingAgents.profileAdd")}
            title={t(adding ? "common.cancel" : "codingAgents.profileAdd")}
            aria-expanded={adding}
            disabled={busy}
            onClick={() => {
              setAdding(!adding);
              setName("");
              setDirectory("");
              setError(undefined);
            }}
          >
            {adding ? <X size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
      <div
        className="provider-models-list agent-account-profile-list"
        role="radiogroup"
        aria-label={t("codingAgents.profileDefault")}
      >
        {profiles.map((profile) => {
          const label =
            profile.id === "system"
              ? t("codingAgents.profileSystem")
              : profile.name;
          const selected = profile.id === defaultProfileId;
          const signedOut = profile.auth.status === "signed-out";
          return (
            <div className="provider-model-row is-compact" key={profile.id}>
              <label title={profile.configDirectory}>
                <input
                  type="radio"
                  name={`${runtime}-account-default`}
                  aria-label={t("codingAgents.profileUseDefault", {
                    name: label,
                  })}
                  checked={selected}
                  disabled={busy}
                  onChange={() => void run(() => onDefault(profile.id))}
                />
                <span className="provider-model-copy">
                  <strong>{label}</strong>
                  {selected ? (
                    <small
                      className="provider-model-default"
                      title={t("codingAgents.profileDefault")}
                    >
                      {t("agents.default")}
                    </small>
                  ) : null}
                  <small title={profile.auth.account}>
                    {profile.auth.account ??
                      t(
                        signedOut
                          ? "codingAgents.signedOut"
                          : profile.auth.status === "signed-in"
                            ? "codingAgents.signedIn"
                            : "codingAgents.accountUnknown",
                      )}
                  </small>
                </span>
              </label>
              {profile.limits?.length ? (
                <AgentUsageInline limits={profile.limits} compact />
              ) : null}
              <button
                className={
                  signedOut
                    ? "agent-account-sign-in"
                    : "icon-button agent-account-reauth"
                }
                type="button"
                aria-label={t(
                  signedOut ? "common.signIn" : "codingAgents.switchAccount",
                )}
                title={t(
                  signedOut ? "common.signIn" : "codingAgents.switchAccount",
                )}
                disabled={busy}
                onClick={() => void onLogin(profile.id)}
              >
                {signedOut ? t("common.signIn") : <RotateCcw size={14} />}
              </button>
              {profile.id !== "system" ? (
                <button
                  className="icon-button settings-provider-setting-edit settings-provider-delete"
                  type="button"
                  aria-label={t("codingAgents.profileDelete", { name: label })}
                  title={t("codingAgents.profileDelete", { name: label })}
                  aria-expanded={deleting?.id === profile.id}
                  disabled={busy}
                  onClick={() => {
                    setDeleting(profile);
                    setError(undefined);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {deleting ? (
        <div
          className="settings-provider-delete-confirmation"
          role="group"
          aria-label={t("codingAgents.profileDelete", { name: deleting.name })}
        >
          <span>
            {t(
              deleting.managed
                ? "codingAgents.profileDeleteManaged"
                : "codingAgents.profileDeleteImported",
              { name: deleting.name },
            )}
          </span>
          <button
            className="settings-danger-button"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await deleteAccountProfile(runtime, deleting.id);
                setProfiles((current) =>
                  current.filter((profile) => profile.id !== deleting.id),
                );
                setDeleting(undefined);
                await onRemoved();
              })
            }
          >
            {t(working ? "common.deleting" : "common.delete")}
          </button>
          <button
            className="settings-secondary-button"
            type="button"
            disabled={busy}
            onClick={() => setDeleting(undefined)}
          >
            {t("common.cancel")}
          </button>
        </div>
      ) : null}
      {adding ? (
        <form className="agent-account-profile-form" onSubmit={add}>
          <div className="settings-detail-inline">
            <input
              className="settings-search-input"
              aria-label={t("codingAgents.profileName")}
              placeholder={t("codingAgents.profileName")}
              value={name}
              maxLength={80}
              required
              autoFocus
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              className="settings-add-button"
              type="submit"
              disabled={busy || !name.trim()}
            >
              {t("common.add")}
            </button>
          </div>
          <details className="settings-provider-advanced">
            <summary>
              <ChevronDown size={12} />
              {t("codingAgents.profileImport")}
            </summary>
            <input
              className="settings-search-input"
              aria-label={t("codingAgents.profileDirectory")}
              placeholder={t("codingAgents.profileDirectory")}
              value={directory}
              disabled={busy}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </details>
        </form>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
