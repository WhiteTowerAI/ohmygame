import { useEffect, useRef, useState } from "react";
import { gameTuningValue, type GameTuningItem, type GameTuningScalar, type GameTuningState } from "../shared/game-tuning.js";
import { getGameTuning, saveGameTuning, setGameTuningDraft, undoProjectPluginChange } from "./api.js";
import { t } from "./i18n.js";
import { RotateCcw, X } from "./icons.js";
import { Alert, Button, Empty, IconButton, Slider, Switch } from "./ui/index.js";

const FILE_FORMAT = `{ "schemaVersion": 1, "values": [{ "id": "player.jumpHeight", "label": "<short name in the language this person uses>", "value": 420, "min": 100, "max": 800, "step": 10 }] }`;
const CONTRACT = `The file is public/tuning.json when the project has a public folder, otherwise tuning.json. Its format is ${FILE_FORMAT}; a value of true or false makes a toggle and needs no range. The game reads it with fetch, not import, and defines window.__OHMYGAME_TUNING__ = { set(id, value) { ... } } so a new value takes effect at once, without restarting. Use the game-tuning skill when it is available.`;
const SET_UP_PROMPT = `Make this game tunable from the Tune panel: move the 5 to 10 constants that most shape how it plays into its tuning file. ${CONTRACT}`;
const ADD_MORE_PROMPT = `Add more of this game's constants to its tuning file, choosing the ones that most shape how it plays and keeping the current values. ${CONTRACT}`;
const CONNECT_PROMPT = `This game has a tuning file, but the running game isn't listening for new values. Connect it. ${CONTRACT} If the page has a Content-Security-Policy that blocks the preview's script, say so.`;
const fixPrompt = (file: string, error: string) => `${file} can't be used as this game's tuning file: ${error} Fix it. ${CONTRACT}`;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Sits beside the game rather than over it: a native game view hides beneath
 * anything laid over it, and the game has to stay in sight while values change.
 */
export function GameTuningPanel({ projectId, previewReady, announced, revision, onAskAgent, onClose }: {
  projectId: string;
  previewReady: boolean;
  announced?: GameTuningState;
  /** Changes when the project's files were restored or an agent finished. */
  revision: number;
  onAskAgent?: (text: string) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<GameTuningState>();
  // What was moved and not yet confirmed, so an older answer can't move the slider back.
  const [moved, setMoved] = useState<Record<string, GameTuningScalar>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ file: string; changeId?: string }>();
  const [undone, setUndone] = useState(false);
  const unsent = useRef(new Map<string, GameTuningScalar | null>());
  const sending = useRef<Promise<boolean> | undefined>(undefined);
  // Answers and announcements can cross, so the newest state wins whatever arrives last.
  const newest = useRef(0);
  const receive = (next: GameTuningState) => {
    if (next.sequence < newest.current) return;
    newest.current = next.sequence;
    setState(next);
  };

  useEffect(() => {
    let current = true;
    void getGameTuning(projectId).then((next) => { if (current) receive(next); }, (cause) => { if (current) setError(message(cause)); });
    return () => { current = false; };
  }, [projectId, revision]);
  useEffect(() => { if (announced) receive(announced); }, [announced]);

  // Only the latest value of a dragged slider matters, one request at a time.
  function flush(): Promise<boolean> {
    // With nothing to send the run below would end before it is stored, and stay stored.
    if (!sending.current && !unsent.current.size) return Promise.resolve(true);
    sending.current ??= (async () => {
      try {
        while (unsent.current.size) {
          const values = Object.fromEntries(unsent.current);
          unsent.current.clear();
          receive(await setGameTuningDraft(projectId, values));
        }
        setMoved({});
        setError(undefined);
        return true;
      } catch (cause) {
        unsent.current.clear();
        setMoved({});
        setError(message(cause));
        return false;
      } finally {
        sending.current = undefined;
      }
    })();
    return sending.current;
  }

  function change(id: string, value: GameTuningScalar | null) {
    setSaved(undefined);
    setUndone(false);
    unsent.current.set(id, value);
    setMoved((current) => {
      const { [id]: _previous, ...rest } = current;
      return value === null ? rest : { ...rest, [id]: value };
    });
    void flush();
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async () => {
    // What the panel shows is what gets saved, so the last moves go first.
    if (!(await flush())) return;
    const { state: next, changeId } = await saveGameTuning(projectId);
    receive(next);
    setUndone(false);
    setSaved({ file: next.file ?? "", ...(changeId ? { changeId } : {}) });
  });
  const undo = (changeId: string) => run(async () => {
    await undoProjectPluginChange(projectId, changeId);
    receive(await getGameTuning(projectId));
    setSaved(undefined);
    setUndone(true);
  });

  const items = state && !state.error ? state.values : [];
  const value = (item: GameTuningItem) => Object.hasOwn(moved, item.id) ? moved[item.id] : gameTuningValue(state!, item);
  const changes = state ? items.filter((item) => value(item) !== item.value).length : 0;

  return <aside className="game-tuning-panel" aria-label={t("gameTuning.title")}>
    <header className="game-tuning-header">
      <strong>{t("gameTuning.title")}</strong>
      <IconButton size="sm" label={t("gameTuning.close")} onClick={onClose}><X size={14} /></IconButton>
    </header>
    {error ? <Alert tone="danger" title={error} /> : null}
    {state?.error ? <Alert tone="danger" title={t("gameTuning.invalidTitle", { file: state.file ?? "tuning.json" })}
      action={onAskAgent ? <Button size="sm" onClick={() => onAskAgent(fixPrompt(state.file ?? "tuning.json", state.error!))}>{t("gameTuning.fix")}</Button> : undefined}>{state.error}</Alert> : null}
    {state && !state.error && !items.length ? <Empty title={t("gameTuning.emptyTitle")} description={t("gameTuning.empty")}
      action={onAskAgent ? <Button size="sm" variant="primary" onClick={() => onAskAgent(SET_UP_PROMPT)}>{t("gameTuning.setUp")}</Button> : undefined} /> : null}
    {items.length ? <>
      <p className="game-tuning-intro">{t("gameTuning.intro")}</p>
      {!previewReady ? <p className="game-tuning-status">{t("gameTuning.notRunning")}</p>
        : state!.connected ? <p className="game-tuning-status is-connected" role="status">{t("gameTuning.connected")}</p>
        : <Alert title={t("gameTuning.notConnectedTitle")} action={onAskAgent ? <Button size="sm" onClick={() => onAskAgent(CONNECT_PROMPT)}>{t("gameTuning.connect")}</Button> : undefined}>{t("gameTuning.notConnected")}</Alert>}
      <div className="game-tuning-values">
        {items.map((item) => {
          const current = value(item);
          return <div className={`game-tuning-value${current !== item.value ? " is-changed" : ""}`} key={item.id}>
            <div className="game-tuning-label">
              <span title={item.id}>{item.label}</span>
              {current !== item.value ? <IconButton size="sm" label={t("gameTuning.resetValue", { label: item.label })} onClick={() => change(item.id, null)}><RotateCcw size={12} /></IconButton> : null}
            </div>
            {"min" in item
              ? <Slider label={item.label} min={item.min} max={item.max} step={item.step ?? (item.max - item.min) / 100} value={current as number} onChange={(next) => change(item.id, next)} format={(number) => String(Number(number.toFixed(4)))} />
              : <Switch size="sm" label={item.label} checked={current as boolean} onChange={(next) => change(item.id, next)} />}
          </div>;
        })}
      </div>
      <footer className="game-tuning-footer">
        {saved ? <p className="game-tuning-status" role="status">{t("gameTuning.saved", { file: saved.file })}
          {saved.changeId ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo(saved.changeId!)}>{t("gameTuning.undo")}</Button> : null}</p>
          : undone ? <p className="game-tuning-status" role="status">{t("gameTuning.undone")}</p>
          : changes ? <p className="game-tuning-status" role="status">{t("gameTuning.changed", { count: changes })}</p> : null}
        <div className="game-tuning-actions">
          <Button size="sm" variant="primary" disabled={busy || !changes} onClick={() => void save()}>{t("gameTuning.save")}</Button>
          <Button size="sm" disabled={busy || !changes} onClick={() => { for (const item of items) if (value(item) !== item.value) change(item.id, null); }}>{t("gameTuning.revert")}</Button>
          {onAskAgent ? <Button size="sm" variant="ghost" onClick={() => onAskAgent(ADD_MORE_PROMPT)}>{t("gameTuning.addMore")}</Button> : null}
        </div>
      </footer>
    </> : null}
  </aside>;
}
