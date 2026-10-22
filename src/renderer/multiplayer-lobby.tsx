import { useEffect, useRef, useState } from "react";
import type {
  MultiplayerManifestConfig,
  MultiplayerSnapshot,
  PublicMultiplayerRoom,
  TurnCommand,
} from "../shared/multiplayer-protocol.js";
import {
  MultiplayerClient,
  type MultiplayerConnectionStatus,
} from "./multiplayer-client.js";
import { createSupabaseClient } from "./auth-client.js";
import { t } from "./i18n.js";

/** The reference game adapter renders only server snapshots. */
export function MultiplayerLobby({
  manifest,
}: {
  manifest: MultiplayerManifestConfig;
}) {
  const client = useRef<MultiplayerClient | undefined>(undefined);
  const [status, setStatus] = useState<MultiplayerConnectionStatus>("idle");
  const [snapshot, setSnapshot] = useState<MultiplayerSnapshot>();
  const [playerId, setPlayerId] = useState("");
  const [roomCode, setRoomCode] = useState(
    () =>
      new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "",
  );
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [rooms, setRooms] = useState<PublicMultiplayerRoom[]>([]);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [account, setAccount] = useState(false);
  const auth = useRef<ReturnType<typeof createSupabaseClient>>(undefined);
  const direction = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const supabase = (auth.current = createSupabaseClient());
    const instance = new MultiplayerClient(
      {
        manifest,
        accessToken: async () =>
          (await supabase?.auth.getSession())?.data.session?.access_token,
      },
      {
        onStatus: (value) => {
          setStatus(value);
          if (value !== "connected" && value !== "reconnecting")
            setSnapshot(undefined);
        },
        onSnapshot: setSnapshot,
        onReady: (id, code) => {
          setPlayerId(id);
          if (code) setInviteCode(code);
        },
        onCommandResult: (result) => {
          setPending(false);
          if (!result.accepted)
            setError(result.error?.message ?? t("multiplayer.commandRejected"));
        },
        onError: (cause) => {
          setError(cause.message);
          setPending(false);
        },
      },
    );
    client.current = instance;
    void instance.reconnect();
    let active = true;
    if (supabase) {
      void (async () => {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        if (code) {
          const result = await supabase.auth.exchangeCodeForSession(code);
          if (result.error) throw result.error;
          url.searchParams.delete("code");
          window.history.replaceState(null, "", url);
        }
        const result = await supabase.auth.getSession();
        if (active) setAccount(!!result.data.session);
      })().catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    }
    const subscription = supabase?.auth.onAuthStateChange((_event, session) => {
      if (active) setAccount(!!session);
    }).data.subscription;
    return () => {
      active = false;
      subscription?.unsubscribe();
      instance.dispose();
      client.current = undefined;
    };
  }, [manifest]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const connected = status === "connected";
  const busy = status === "connecting" || status === "reconnecting";
  const state = snapshot?.state;
  const owner = state?.ownerId === playerId;

  useEffect(() => {
    if (
      manifest.mode !== "realtime" ||
      !connected ||
      state?.phase !== "playing"
    )
      return;
    const keys = new Set<string>();
    const update = () => {
      direction.current = {
        x: Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft")),
        y: Number(keys.has("ArrowDown")) - Number(keys.has("ArrowUp")),
      };
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.key.startsWith("Arrow") &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        keys.add(event.key);
        update();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      keys.delete(event.key);
      update();
    };
    const reset = () => {
      keys.clear();
      direction.current = { x: 0, y: 0 };
      client.current?.sendInput(0, 0);
    };
    const timer = setInterval(
      () => client.current?.sendInput(direction.current.x, direction.current.y),
      50,
    );
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", reset);
    return () => {
      clearInterval(timer);
      reset();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", reset);
    };
  }, [manifest.mode, connected, state?.phase]);

  async function run(operation: () => Promise<unknown>) {
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  function command(
    type: TurnCommand["type"],
    payload?: TurnCommand["payload"],
  ) {
    setError("");
    try {
      client.current?.sendCommand(type, payload);
      setPending(true);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function signIn(provider: "google" | "github") {
    if (!auth.current) {
      setError(t("multiplayer.authUnavailable"));
      return;
    }
    const result = await auth.current.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.href },
    });
    if (result.error) throw result.error;
  }
  const canJoin =
    !busy &&
    status !== "connected" &&
    (manifest.authPolicy !== "account-required" || account);
  const countdown = state?.turnDeadline
    ? Math.max(0, Math.ceil((state.turnDeadline - now) / 1000))
    : 0;
  const inviteUrl = new URL(window.location.href);
  if (inviteCode)
    inviteUrl.hash = new URLSearchParams({ invite: inviteCode }).toString();

  return (
    <main className="multiplayer-game" aria-label={t("multiplayer.ariaLabel")}>
      <section className="multiplayer-lobby">
        <div className="multiplayer-lobby-row">
          <h1>
            {manifest.mode === "realtime"
              ? t("multiplayer.arenaTitle")
              : t("multiplayer.stonesTitle")}
          </h1>
          <span role="status">{t(`multiplayer.${status}`)}</span>
        </div>
        <p>
          {manifest.mode === "realtime"
            ? t("multiplayer.arenaRules")
            : t("multiplayer.stonesRules")}
        </p>
        {!connected ? (
          <>
            {manifest.authPolicy !== "anonymous" && !account ? (
              <div className="multiplayer-lobby-row">
                <button
                  type="button"
                  onClick={() => void run(() => signIn("google"))}
                >
                  {t("multiplayer.signInGoogle")}
                </button>
                <button
                  type="button"
                  onClick={() => void run(() => signIn("github"))}
                >
                  {t("multiplayer.signInGithub")}
                </button>
              </div>
            ) : null}
            <div className="multiplayer-lobby-row">
              <input
                aria-label={t("multiplayer.namePlaceholder")}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("multiplayer.namePlaceholder")}
                maxLength={40}
                disabled={busy}
              />
              <input
                aria-label={t("multiplayer.roomCodePlaceholder")}
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value)}
                placeholder={t("multiplayer.roomCodePlaceholder")}
                maxLength={16}
                disabled={busy}
              />
              <button
                disabled={!canJoin}
                type="button"
                onClick={() =>
                  void run(() => client.current!.createRoom({ displayName }))
                }
              >
                {t("multiplayer.createRoom")}
              </button>
              <button
                disabled={
                  !canJoin ||
                  (manifest.roomPolicy === "invite-only" && !roomCode.trim())
                }
                type="button"
                onClick={() =>
                  void run(() =>
                    client.current!.joinRoom({
                      displayName,
                      roomCode: roomCode.trim() || undefined,
                    }),
                  )
                }
              >
                {t("multiplayer.joinRoom")}
              </button>
              <button
                disabled={!canJoin}
                type="button"
                onClick={() => void run(() => client.current!.reconnect())}
              >
                {t("multiplayer.retry")}
              </button>
              {manifest.roomPolicy !== "invite-only" ? (
                <button
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void run(async () =>
                      setRooms(await client.current!.publicRooms()),
                    )
                  }
                >
                  {t("multiplayer.findRooms")}
                </button>
              ) : null}
            </div>
            {rooms.map((room) => (
              <button
                type="button"
                key={room.roomId}
                disabled={!canJoin}
                onClick={() =>
                  void run(() =>
                    client.current!.joinRoom({
                      displayName,
                      roomId: room.roomId,
                    }),
                  )
                }
              >
                {room.roomId} · {room.clients}/{room.maxClients}
              </button>
            ))}
          </>
        ) : (
          <div className="multiplayer-lobby-row">
            {inviteCode ? (
              <>
                <code>{inviteCode}</code>
                <button
                  type="button"
                  onClick={() =>
                    void run(() =>
                      navigator.clipboard.writeText(inviteUrl.href),
                    )
                  }
                >
                  {t("multiplayer.copyInvite")}
                </button>
              </>
            ) : null}
            {owner && state?.phase === "lobby" ? (
              <button
                disabled={
                  pending ||
                  (state?.players.filter((p) => p.connected).length ?? 0) < 2
                }
                type="button"
                onClick={() => command("start")}
              >
                {t("multiplayer.start")}
              </button>
            ) : null}
            {owner ? (
              <button
                disabled={pending}
                type="button"
                onClick={() => command("close")}
              >
                {t("multiplayer.closeRoom")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await client.current!.leave();
                  setPending(false);
                  setInviteCode("");
                  setSnapshot(undefined);
                })
              }
            >
              {t("multiplayer.leave")}
            </button>
          </div>
        )}
        {error ? <p role="alert">{error}</p> : null}
        {state ? (
          <ul className="multiplayer-members">
            {state.players.map((player) => (
              <li key={player.playerId}>
                <span>
                  {player.displayName}
                  {player.playerId === playerId
                    ? ` · ${t("multiplayer.you")}`
                    : ""}{" "}
                  ·{" "}
                  {t(
                    player.connected
                      ? "multiplayer.connected"
                      : "multiplayer.offline",
                  )}
                </span>
                {owner && player.playerId !== playerId ? (
                  <button
                    disabled={!connected || pending}
                    type="button"
                    onClick={() =>
                      command("kick", { playerId: player.playerId })
                    }
                  >
                    {t("multiplayer.kick")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {state?.phase === "playing" && manifest.mode === "turn-based" ? (
        <section className="multiplayer-lobby">
          <h2>{t("multiplayer.remaining", { count: state.remaining })}</h2>
          <p>
            {t("multiplayer.turn", {
              name:
                state.players.find((p) => p.playerId === state.currentPlayerId)
                  ?.displayName ?? "",
              seconds: countdown,
            })}
          </p>
          <div className="multiplayer-lobby-row">
            {[1, 2, 3].map((count) => (
              <button
                key={count}
                disabled={
                  !connected ||
                  pending ||
                  state.currentPlayerId !== playerId ||
                  state.remaining < count
                }
                type="button"
                onClick={() => command("take", { count })}
              >
                {t("multiplayer.take", { count })}
              </button>
            ))}
            <button
              disabled={
                !connected || pending || state.currentPlayerId !== playerId
              }
              type="button"
              onClick={() => command("pass")}
            >
              {t("multiplayer.pass")}
            </button>
          </div>
        </section>
      ) : null}
      {state && manifest.mode === "realtime" ? (
        <section className="multiplayer-lobby">
          <div
            className="multiplayer-arena"
            aria-label={t("multiplayer.arenaTitle")}
          >
            <span className="multiplayer-goal" />
            {state.players.map((player) => (
              <span
                key={player.playerId}
                className={`multiplayer-piece${player.playerId === playerId ? " is-you" : ""}`}
                style={{ left: `${player.x}%`, top: `${player.y}%` }}
                title={player.displayName}
              >
                {player.displayName.slice(0, 1)}
              </span>
            ))}
          </div>
          <div className="multiplayer-lobby-row">
            {[
              ["←", -1, 0],
              ["↑", 0, -1],
              ["↓", 0, 1],
              ["→", 1, 0],
            ].map(([label, x, y]) => (
              <button
                className="multiplayer-direction"
                type="button"
                key={label}
                disabled={!connected || state.phase !== "playing"}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  direction.current = { x: Number(x), y: Number(y) };
                }}
                onPointerUp={() => {
                  direction.current = { x: 0, y: 0 };
                }}
                onPointerCancel={() => {
                  direction.current = { x: 0, y: 0 };
                }}
                aria-label={t("multiplayer.move", { direction: String(label) })}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {state?.phase === "finished" ? (
        <p role="status">
          {t("multiplayer.winner", {
            name:
              state.players.find((p) => p.playerId === state.winnerPlayerId)
                ?.displayName ?? "",
          })}
        </p>
      ) : null}
    </main>
  );
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
