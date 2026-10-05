import { useCallback, useEffect, useRef, useState } from "react";
import { loadModes, type LoadConfig, type LoadMode, type LoadReport, type LoadSample } from "@testforge/shared";
import { api, type Project, type Run, type SavedRequest } from "../api";
import { usePersistentState } from "../store";
import { LoadDashboard } from "./LoadReport";

const MODE_LABELS: Record<LoadMode, string> = {
  load: "Carga (estable)", stress: "Estrés (escalones)", spike: "Picos", soak: "Resistencia (larga)",
};
const MODE_HELP: Record<LoadMode, string> = {
  load: "Mantiene N usuarios constantes para medir el rendimiento normal.",
  stress: "Sube los usuarios por escalones hasta el máximo para encontrar el punto de quiebre.",
  spike: "Carga baja con un pico repentino, para ver cómo reacciona y se recupera.",
  soak: "Carga estable durante mucho tiempo, para detectar fugas de memoria o degradación.",
};

const defaultConfig = (): LoadConfig => ({
  mode: "load", vus: 20, rampUpSec: 10, durationSec: 60, thinkTimeMs: 0, maxRps: null,
  validateAssertions: true, requestIds: null,
  thresholds: { p95Ms: 800, errorRatePct: 1, minRps: null },
});

export function LoadView({ project, environmentId }: { project: Project; environmentId: string | null }) {
  const [requests, setRequests] = useState<SavedRequest[]>([]);
  const [cfg, setCfg] = usePersistentState<LoadConfig>(`load:${project.id}`, defaultConfig);
  const [run, setRun] = useState<Run | null>(null);
  const [samples, setSamples] = useState<LoadSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { void api.requests(project.id).then(setRequests); }, [project.id]);
  const patch = (p: Partial<LoadConfig>) => setCfg((c) => ({ ...c, ...p }));
  const patchTh = (p: Partial<LoadConfig["thresholds"]>) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, ...p } }));

  const running = run?.status === "queued" || run?.status === "running";
  const summaryLoad = (run?.summary as { load?: LoadReport } | null)?.load ?? null;

  // Mientras corre, pide estado y muestras cada segundo
  const poll = useCallback(async (id: string) => {
    try {
      const [r, sm] = await Promise.all([api.run(id), api.samples(id)]);
      setRun(r); setSamples(sm);
      if (r.status === "queued" || r.status === "running") timer.current = setTimeout(() => poll(id), 1000);
    } catch { timer.current = setTimeout(() => poll(id), 2000); }
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = async () => {
    setError(null); setStarting(true); setSamples([]);
    try {
      const r = await api.startRun(project.id, environmentId, { kind: "load", load: cfg });
      setRun(r);
      void poll(r.id);
    } catch (e) { setError((e as Error).message); }
    setStarting(false);
  };
  const stop = async () => { if (run) { await api.stopRun(run.id).catch(() => {}); } };

  const est = estimate(cfg);

  return (
    <div className="load-view">
      <div className="banner info">
        Usa esta herramienta solo contra sistemas propios o para los que tengas autorización por escrito. Generar carga
        contra servicios de terceros sin permiso puede ser ilegal.
      </div>

      <div className="load-grid">
        <section className="card load-form">
          <h3>Configuración</h3>
          <label className="field">
            <span>Tipo de prueba</span>
            <select value={cfg.mode} onChange={(e) => patch({ mode: e.target.value as LoadMode })} disabled={running}>
              {loadModes.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
            </select>
          </label>
          <p className="muted small">{MODE_HELP[cfg.mode]}</p>

          <div className="field-row">
            <label className="field"><span>Usuarios virtuales</span>
              <input type="text" inputMode="numeric" value={cfg.vus} disabled={running}
                onChange={(e) => patch({ vus: clamp(e.target.value, 1, 5000, cfg.vus) })} /></label>
            <label className="field"><span>Duración (seg)</span>
              <input type="text" inputMode="numeric" value={cfg.durationSec} disabled={running}
                onChange={(e) => patch({ durationSec: clamp(e.target.value, 5, 86400, cfg.durationSec) })} /></label>
          </div>
          <div className="field-row">
            <label className="field"><span>Subida (seg)</span>
              <input type="text" inputMode="numeric" value={cfg.rampUpSec} disabled={running}
                onChange={(e) => patch({ rampUpSec: clamp(e.target.value, 0, 3600, cfg.rampUpSec) })} /></label>
            <label className="field"><span>Pausa entre req. (ms)</span>
              <input type="text" inputMode="numeric" value={cfg.thinkTimeMs} disabled={running}
                onChange={(e) => patch({ thinkTimeMs: clamp(e.target.value, 0, 60000, cfg.thinkTimeMs) })} /></label>
          </div>
          <label className="field"><span>Límite de peticiones/seg (opcional)</span>
            <input type="text" inputMode="numeric" placeholder="sin límite" value={cfg.maxRps ?? ""} disabled={running}
              onChange={(e) => patch({ maxRps: e.target.value.trim() === "" ? null : clamp(e.target.value, 1, 100000, cfg.maxRps ?? 1) })} /></label>

          <label className="check"><input type="checkbox" checked={cfg.validateAssertions} disabled={running}
            onChange={(e) => patch({ validateAssertions: e.target.checked })} /> Contar como error si falla una aserción del request</label>

          <h4>Requests a usar</h4>
          <label className="check"><input type="radio" checked={cfg.requestIds === null} disabled={running}
            onChange={() => patch({ requestIds: null })} /> Todos ({requests.length})</label>
          <label className="check"><input type="radio" checked={cfg.requestIds !== null} disabled={running}
            onChange={() => patch({ requestIds: requests.map((r) => r.id) })} /> Elegir cuáles</label>
          {cfg.requestIds !== null && (
            <div className="req-pick">
              {requests.map((r) => (
                <label key={r.id} className="check small">
                  <input type="checkbox" disabled={running}
                    checked={cfg.requestIds!.includes(r.id)}
                    onChange={(e) => patch({ requestIds: e.target.checked ? [...cfg.requestIds!, r.id] : cfg.requestIds!.filter((x) => x !== r.id) })} />
                  <span className={`method m-${r.method}`}>{r.method}</span> {r.name}
                </label>
              ))}
            </div>
          )}

          <h4>Umbrales (deciden si pasa o falla)</h4>
          <div className="field-row">
            <label className="field"><span>p95 menor que (ms)</span>
              <input type="text" inputMode="numeric" placeholder="—" value={cfg.thresholds.p95Ms ?? ""} disabled={running}
                onChange={(e) => patchTh({ p95Ms: numOrNull(e.target.value) })} /></label>
            <label className="field"><span>Error menor que (%)</span>
              <input type="text" inputMode="numeric" placeholder="—" value={cfg.thresholds.errorRatePct ?? ""} disabled={running}
                onChange={(e) => patchTh({ errorRatePct: numOrNull(e.target.value) })} /></label>
          </div>
          <label className="field"><span>Peticiones/seg mayor que</span>
            <input type="text" inputMode="numeric" placeholder="—" value={cfg.thresholds.minRps ?? ""} disabled={running}
              onChange={(e) => patchTh({ minRps: numOrNull(e.target.value) })} /></label>

          <p className="muted small">Duración total estimada: ~{est.totalSec}s. {est.note}</p>
          {error && <div className="banner error">{error}</div>}
          {running ? (
            <button className="btn danger full" onClick={stop}>■ Detener prueba</button>
          ) : (
            <button className="btn primary full" disabled={starting || requests.length === 0} onClick={start}>
              {starting ? "Iniciando…" : "▶ Iniciar prueba de carga"}
            </button>
          )}
          {requests.length === 0 && <p className="muted small">Crea al menos un request en "Requests API" para poder lanzar carga.</p>}
        </section>

        <section className="load-live">
          {!run && <div className="empty"><h2>Prueba de carga</h2><p>Configura a la izquierda y pulsa Iniciar. Verás las gráficas actualizarse en vivo.</p></div>}
          {run && <LoadDashboard run={run} samples={samples} report={summaryLoad} live={running} />}
        </section>
      </div>
    </div>
  );
}

function estimate(cfg: LoadConfig) {
  const rampDown = Math.min(10, Math.max(2, Math.round((cfg.rampUpSec || 4) / 2)));
  let totalSec = cfg.durationSec + cfg.rampUpSec + rampDown;
  if (cfg.mode === "stress") totalSec = cfg.durationSec + rampDown;
  if (cfg.mode === "spike") totalSec = Math.round(cfg.rampUpSec + cfg.durationSec + 4 + rampDown);
  const note = cfg.mode === "soak" ? "En resistencia conviene una duración larga (p. ej. 30–60 min)." : "";
  return { totalSec, note };
}
const clamp = (v: string, min: number, max: number, fallback: number) => {
  const n = parseInt(v.replace(/[^\d]/g, ""), 10);
  return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
};
const numOrNull = (v: string): number | null => {
  const t = v.replace(/[^\d.]/g, "");
  return t === "" ? null : Number(t);
};
