import { useEffect, useRef, useState } from "react";
import type { Model3DBalance, Model3DModelRef } from "../shared/contracts.js";
import { model3DBalance, MODELS_CHANGED_EVENT } from "./api.js";
import { RefreshCw } from "./icons.js";
import { language, t } from "./i18n.js";

const credits = (value: number) => value.toLocaleString(language, { maximumFractionDigits: 3 });

export function Provider3DBalance({ model, label = t("balance.title") }: { model: Model3DModelRef; label?: string }) {
  const { provider, id } = model;
  const key = JSON.stringify([provider, id]);
  const [state, setState] = useState<{ key: string; value?: Model3DBalance; loading: boolean; error?: boolean }>();
  const refreshRef = useRef<() => void>(() => {});
  const current = state?.key === key ? state : undefined;
  const loading = !current || current.loading;

  useEffect(() => {
    let active = true, sequence = 0;
    const load = async (clear = false) => {
      const request = ++sequence;
      setState((previous) => ({ key, value: !clear && previous?.key === key ? previous.value : undefined, loading: true }));
      try {
        const value = await model3DBalance({ provider, id });
        if (active && request === sequence) setState({ key, value, loading: false });
      } catch {
        if (active && request === sequence) setState({ key, loading: false, error: true });
      }
    };
    const refresh = () => { void load(); };
    const changed = () => { void load(true); };
    refreshRef.current = refresh;
    changed();
    window.addEventListener("focus", refresh);
    window.addEventListener(MODELS_CHANGED_EVENT, changed);
    return () => { active = false; refreshRef.current = () => {}; window.removeEventListener("focus", refresh); window.removeEventListener(MODELS_CHANGED_EVENT, changed); };
  }, [provider, id, key]);

  return <section className="settings-detail-section provider-models" aria-label={label}>
    <div className="provider-models-heading">
      <h4>{label}</h4>
      <button type="button" className="icon-button settings-provider-setting-edit" aria-label={t("balance.refreshLabel")} data-tooltip={t("balance.refresh")} disabled={loading} onClick={() => refreshRef.current()}>
        <RefreshCw size={15} className={loading ? "spin" : undefined} aria-hidden="true" />
      </button>
    </div>
    <div className="cloud-quota-details" role="status" aria-live="polite" aria-busy={loading}>
      <div className="cloud-quota-row-heading"><span>{t("balance.available")}</span><span>{current?.value ? t("balance.credits", { amount: credits(current.value.balance) }) : loading ? t("common.loading") : t("quota.unavailable")}</span></div>
      {current?.value?.frozen ? <p className="cloud-quota-note">{t("balance.frozen", { amount: credits(current.value.frozen) })}</p> : null}
      {current?.error ? <p className="cloud-quota-note">{t("balance.error")}</p> : null}
    </div>
  </section>;
}
