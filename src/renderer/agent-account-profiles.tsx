import { useEffect, useState, type FormEvent } from "react";
import type {
  AccountRuntimeId,
  AgentAccountProfileStatus,
} from "../shared/agent-runtimes.js";
import {
  addAccountProfile,
  deleteAccountProfile,
  listAccountProfiles,
  moveAccountProfile,
  updateAccountProfile,
} from "./api.js";
import { AgentUsageInline } from "./agent-usage.js";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "./icons.js";
import { t } from "./i18n.js";
import { Disclosure, DropdownMenu, type MenuEntry } from "./ui/index.js";

/** Named references to CLI-owned configuration directories, with the CLI's own sign-in flow. */
export function AgentAccountProfiles({
  runtime,
  defaultProfileId,
  onDefault,
  onLogin,
  onChanged,
  disabled,
}: {
  runtime: AccountRuntimeId;
  defaultProfileId: string;
  onDefault: (id: string) => Promise<void>;
  onLogin: (id: string) => Promise<void>;
  /** The list changed in a way others show: a name, the order, a directory or a removal. */
  onChanged: () => Promise<void>;
  disabled: boolean;
}) {
  const [profiles, setProfiles] = useState<AgentAccountProfileStatus[]>([]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<AgentAccountProfileStatus>();
  const [editing, setEditing] = useState<AgentAccountProfileStatus>();
  const [editName, setEditName] = useState("");
  const [editDirectory, setEditDirectory] = useState("");
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
          directory: profile.configDirectory ?? "",
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
  function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    void run(async () => {
      const name = editName.trim();
      const directory = editDirectory.trim();
      const change = {
        ...(name !== editing.name ? { name } : {}),
        ...(directory !== editing.directory ? { configDirectory: directory } : {}),
      };
      if (Object.keys(change).length) {
        await updateAccountProfile(runtime, editing.id, change);
        setProfiles(await listAccountProfiles(runtime));
        await onChanged();
      }
      setEditing(undefined);
    });
  }
  function menu(
    profile: AgentAccountProfileStatus,
    label: string,
    index: number,
  ): MenuEntry[] {
    const move = (direction: -1 | 1) =>
      void run(async () => {
        await moveAccountProfile(runtime, profile.id, direction);
        setProfiles(await listAccountProfiles(runtime));
        await onChanged();
      });
    const browse = window.ohMyGameDesktop?.browseAccountDirectory;
    const directoryItems: MenuEntry[] = [
      ...(browse
        ? [
            {
              label: t("codingAgents.profileOpenDirectory"),
              icon: <FolderOpen size={14} />,
              onSelect: () => void run(() => browse(runtime, profile.id)),
            },
          ]
        : []),
      {
        label: t("codingAgents.profileCopyDirectory"),
        icon: <Copy size={14} />,
        onSelect: () =>
          void run(() => navigator.clipboard.writeText(profile.directory)),
      },
    ];
    if (profile.id === "system") return directoryItems;
    return [
      {
        label: t("codingAgents.profileEdit"),
        icon: <Pencil size={14} />,
        onSelect: () => {
          setEditing(profile);
          setEditName(profile.name);
          setEditDirectory(profile.directory);
          setDeleting(undefined);
          setAdding(false);
          setError(undefined);
        },
      },
      {
        label: t("codingAgents.profileMoveUp"),
        icon: <ChevronUp size={14} />,
        // System default holds the first place.
        disabled: index <= 1,
        onSelect: () => move(-1),
      },
      {
        label: t("codingAgents.profileMoveDown"),
        icon: <ChevronDown size={14} />,
        disabled: index === profiles.length - 1,
        onSelect: () => move(1),
      },
      "separator",
      ...directoryItems,
      "separator",
      {
        label: t("codingAgents.profileDelete", { name: label }),
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => {
          setDeleting(profile);
          setEditing(undefined);
          setError(undefined);
        },
      },
    ];
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
              setEditing(undefined);
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
        {profiles.map((profile, index) => {
          const label =
            profile.id === "system"
              ? t("codingAgents.profileSystem")
              : profile.name;
          const selected = profile.id === defaultProfileId;
          const signedOut = profile.auth.status === "signed-out";
          return (
            <div className="provider-model-row is-compact" key={profile.id}>
              <label title={profile.directory}>
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
              <DropdownMenu
                placement="bottom-end"
                items={menu(profile, label, index)}
                trigger={(props) => (
                  <button
                    {...props}
                    className="icon-button settings-provider-setting-edit"
                    type="button"
                    aria-label={t("codingAgents.profileActions", { name: label })}
                    title={t("codingAgents.profileActions", { name: label })}
                    disabled={busy}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                )}
              />
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
                await onChanged();
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
      {editing ? (
        <form
          className="agent-account-profile-form"
          aria-label={t("codingAgents.profileEditTitle", { name: editing.name })}
          onSubmit={save}
        >
          <div className="settings-detail-inline">
            <input
              className="settings-search-input"
              aria-label={t("codingAgents.profileName")}
              placeholder={t("codingAgents.profileName")}
              value={editName}
              maxLength={80}
              required
              autoFocus
              disabled={busy}
              onChange={(event) => setEditName(event.target.value)}
            />
            <button
              className="settings-add-button"
              type="submit"
              disabled={busy || !editName.trim() || !editDirectory.trim()}
            >
              {t("common.save")}
            </button>
            <button
              className="settings-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              {t("common.cancel")}
            </button>
          </div>
          {editing.managed ? null : (
            <>
              <input
                className="settings-search-input"
                aria-label={t("codingAgents.profileDirectory")}
                placeholder={t("codingAgents.profileDirectory")}
                value={editDirectory}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setEditDirectory(event.target.value)}
              />
              <p className="settings-muted">{t("codingAgents.profileDirectoryHint")}</p>
            </>
          )}
        </form>
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
          <Disclosure summary={t("codingAgents.profileImport")}>
            <input
              className="settings-search-input"
              aria-label={t("codingAgents.profileDirectory")}
              placeholder={t("codingAgents.profileDirectory")}
              value={directory}
              disabled={busy}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </Disclosure>
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
