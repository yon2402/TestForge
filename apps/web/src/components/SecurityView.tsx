import { useCallback, useEffect, useRef, useState } from "react";
import { scanModes, type ScanMode, type SecurityConfig, type SecurityReport } from "@testforge/shared";
import { api, type Project, type Run } from "../api";
import { usePersistentState } from "../store";
import { SecurityReportView } from "./SecurityReport";

const MODE_LABELS: Record<ScanMode, string> = { passive: "Pasivo (seguro)", active: "Activo (envía ataques)" };

const defaultConfig = (project: Project): SecurityConfig => ({
  targetUrl: project.uiBaseUrl || project.baseUrl || "",
  mode: "passive", scope: [], maxDurationMin: 10, authorizedActive: false,
});

export function SecurityView({ project }: { project: Project }) {
  const [cfg, setCfg] = usePersistentState<SecurityConfig>(`sec:${project.id}`, () => defaultConfig(project));
  const [run, setRun] = useState<Run | null>(null);
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patch = (p: Partial<SecurityConfig>) => setCfg((c) => ({ ...c, ...p }));

  const running = run?.status === "queued" || run?.status === "running";
  const report = (run?.summary as { security?: SecurityReport } | null)?.security ?? null;

  const poll = useCallback(async (id: string) => {
    try {
      const [r, pr] = await Promise.all([api.run(id), api.scanProgress(id)]);
      setRun(r); setProgress(pr.progress);
      if (r.status === "queued" || r.status === "running") timer.current = setTimeout(() => poll(id), 1500);
    } catch { timer.current = setTimeout(() => poll(id), 2500); }
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = async () => {
    setError(null); setProgress(null);
    if (cfg.mode === "active" && !cfg.authorizedActive) { setConfirm(true); return; }
    try {
      const r = await api.startRun(project.id, null, { kind: "security", security: cfg });
      setRun(r); void poll(r.id);
    } catch (e) { setError((e as Error).message); }
  };
  const stop = async () => { if (run) await api.stopRun(run.id).catch(() => {}); };

  return (
    <div className="load-view">
      <div className="banner warn">
        <b>Uso autorizado únicamente.</b> Escanea solo sistemas propios o para los que tengas permiso por escrito.
        El escaneo activo <b>envía ataques reales</b> (inyección, XSS…) y puede alterar datos; úsalo en entornos de prueba, nunca en producción.
      </div>

      <div className="load-grid">
        <section className="card load-form">
          <h3>Configuración del escaneo</h3>
          <label className="field"><span>URL objetivo</span>
            <input className="mono" placeholder="http://localhost:3000" value={cfg.targetUrl} disabled={running}
              onChange={(e) => patch({ targetUrl: e.target.value })} /></label>

          <label className="field"><span>Tipo de escaneo</span>
            <select value={cfg.mode} disabled={running} onChange={(e) => patch({ mode: e.target.value as ScanMode, authorizedActive: false })}>
              {scanModes.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
            </select></label>
          <p className="muted small">
            {cfg.mode === "passive"
              ? "Explora el sitio y revisa el tráfico sin atacar: cabeceras, cookies, fugas de información. No modifica nada."
              : "Además del análisis pasivo, prueba vulnerabilidades enviando peticiones maliciosas (XSS, inyección SQL, etc.)."}
          </p>

          <label className="field"><span>Duración máxima (min)</span>
            <input type="text" inputMode="numeric" value={cfg.maxDurationMin} disabled={running}
              onChange={(e) => patch({ maxDurationMin: Math.min(120, Math.max(1, parseInt(e.target.value.replace(/\D/g, ""), 10) || 1)) })} /></label>

          <label className="field"><span>Alcance (opcional, un prefijo por línea)</span>
            <textarea className="mono" rows={3} placeholder={"http://localhost:3000/app\nhttp://localhost:3000/api"}
              value={cfg.scope.join("\n")} disabled={running}
              onChange={(e) => patch({ scope: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} /></label>
          <p className="muted small">Si lo dejas vacío, solo se escanea el mismo dominio de la URL objetivo.</p>

          {error && <div className="banner error">{error}</div>}
          {running ? (
            <button className="btn danger full" onClick={stop}>■ Detener escaneo</button>
          ) : (
            <button className="btn primary full" disabled={!cfg.targetUrl.trim()} onClick={start}>
              {cfg.mode === "active" ? "▶ Iniciar escaneo activo" : "▶ Iniciar escaneo pasivo"}
            </button>
          )}
        </section>

        <section className="load-live">
          {!run && (
            <div className="empty">
              <h2>Escáner de seguridad</h2>
              <p>Usa OWASP ZAP para buscar vulnerabilidades. Requiere ZAP corriendo (incluido en <code>docker compose</code>).</p>
            </div>
          )}
          {run && running && (
            <div className="scan-progress">
              <h3>Escaneando… <span className="pulse">●</span></h3>
              <p className="muted">{progress?.phase ?? "Preparando…"}</p>
              <div className="progress-bar"><div style={{ width: `${progress?.percent ?? 0}%` }} /></div>
              <p className="muted small">{progress?.percent ?? 0}%</p>
            </div>
          )}
          {run && !running && report && <SecurityReportView run={run} report={report} />}
          {run && !running && !report && run.status === "error" && <div className="banner error">El escaneo falló. ¿Está ZAP corriendo? Revisa <code>docker compose</code>.</div>}
        </section>
      </div>

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Confirmar escaneo activo</h3>
            <div className="banner warn">
              El escaneo activo <b>enviará ataques reales</b> a <code>{cfg.targetUrl}</code>. Esto puede crear, modificar o borrar
              datos y afectar el funcionamiento del sistema. Hazlo solo en un entorno de prueba y con autorización.
            </div>
            <label className="check"><input type="checkbox" checked={cfg.authorizedActive}
              onChange={(e) => patch({ authorizedActive: e.target.checked })} />
              Confirmo que tengo autorización para atacar este sistema y que no es producción.</label>
            <div className="row">
              <button className="btn danger" disabled={!cfg.authorizedActive} onClick={async () => { setConfirm(false); await start(); }}>Iniciar escaneo activo</button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
