import { Fragment, useCallback, useEffect, useState } from "react";
import type { RequestResult, UiBrowser } from "@testforge/shared";
import { api, type Project, type Run, type RunDetail } from "../api";
import { ResultView, StatusBadge, UiResultView, engineFromUA } from "./common";
import { BROWSER_LABELS, BrowserPicker } from "./UiTestsView";
import { LoadDashboard } from "./LoadReport";
import { SecurityReportView } from "./SecurityReport";
import type { LoadReport, LoadSample, SecurityReport } from "@testforge/shared";

export function RunsView({ project, environmentId }: { project: Project; environmentId: string | null }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<UiBrowser[]>(["chromium"]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api.runs(project.id);
    setRuns(list);
    setSelectedId((cur) => (cur && list.some((r) => r.id === cur) ? cur : list[0]?.id ?? null));
    setChecked((cur) => new Set([...cur].filter((id) => list.some((r) => r.id === id))));
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  // Mientras haya ejecuciones activas, refresca cada segundo
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [active, load]);

  const start = async (kind: "api" | "ui") => {
    setError(null);
    try {
      const run = await api.startRun(project.id, environmentId, kind === "ui" ? { kind, browsers } : { kind });
      setSelectedId(run.id);
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const isActive = (r: Run) => r.status === "queued" || r.status === "running";
  const deletable = runs.filter((r) => !isActive(r));
  const toggle = (id: string) => setChecked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const remove = async (ids: string[]) => {
    if (ids.length === 0) return;
    const label = ids.length === 1 ? "este reporte" : `${ids.length} reportes`;
    if (!confirm(`¿Eliminar ${label}? También se borran sus capturas, videos y trazas. No se puede deshacer.`)) return;
    setError(null);
    try {
      const res = await api.deleteRuns(ids);
      setNotice(`${res.deleted.length} eliminado${res.deleted.length === 1 ? "" : "s"}` +
        (res.skipped ? ` · ${res.skipped} omitido${res.skipped === 1 ? "" : "s"} (en ejecución)` : ""));
      setChecked(new Set());
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="split">
      <div className="list-pane">
        <div className="run-buttons">
          <button className="btn primary" onClick={() => start("api")} title="Todos los requests de API en orden">▶ API</button>
          <button className="btn primary" onClick={() => start("ui")} title="Todas las pruebas UI en los navegadores elegidos">▶ UI</button>
        </div>
        <p className="muted small">Las pruebas de carga se lanzan desde la pestaña "Carga y estrés".</p>
        <BrowserPicker value={browsers} onChange={setBrowsers} />
        {error && <div className="banner error">{error}</div>}
        {runs.length > 0 && (
          <div className="select-bar">
            <label title="Seleccionar todos">
              <input
                type="checkbox"
                checked={deletable.length > 0 && deletable.every((r) => checked.has(r.id))}
                onChange={(e) => setChecked(e.target.checked ? new Set(deletable.map((r) => r.id)) : new Set())}
              />
              Todos
            </label>
            <button className="link" onClick={() => setChecked(new Set(deletable.filter((r) => r.status !== "passed").map((r) => r.id)))}>Fallidos</button>
            <button className="link" onClick={() => setChecked(new Set(deletable.filter((r) => r.status === "passed").map((r) => r.id)))}>Exitosos</button>
            <button className="btn danger small" disabled={checked.size === 0} onClick={() => remove([...checked])}>
              Eliminar{checked.size ? ` (${checked.size})` : ""}
            </button>
          </div>
        )}
        {notice && <div className="muted small">{notice}</div>}
        {runs.map((r) => (
          <div key={r.id} className={`run-row ${r.id === selectedId ? "active" : ""} ${checked.has(r.id) ? "checked" : ""}`}>
            <input
              type="checkbox"
              checked={checked.has(r.id)}
              disabled={isActive(r)}
              title={isActive(r) ? "No se puede borrar mientras se ejecuta" : "Seleccionar para eliminar"}
              onChange={() => toggle(r.id)}
            />
            <button className="list-item run" onClick={() => setSelectedId(r.id)}>
              <StatusBadge status={r.status} />
              <span className="kind-badge">{r.kind === "ui" ? "UI" : r.kind === "load" ? "CARGA" : r.kind === "security" ? "SEG" : "API"}</span>
              <span className="name">
                {new Date(r.createdAt).toLocaleString()}
                <small>{r.environmentName ?? "sin entorno"}{r.summary ? ` · ${r.summary.passed}/${r.summary.total}` : ""}</small>
              </span>
            </button>
          </div>
        ))}
        {runs.length === 0 && <p className="muted small">Aún no hay ejecuciones.</p>}
      </div>
      <div className="editor-pane">
        {selectedId ? <RunReport key={selectedId} runId={selectedId} refreshKey={runs.find((r) => r.id === selectedId)?.status} onDelete={() => remove([selectedId])} /> : (
          <div className="empty"><h2>Ejecuta tus pruebas</h2><p>▶ API corre los requests en orden; ▶ UI corre las pruebas de navegador. Cada ejecución genera un reporte.</p></div>
        )}
      </div>
    </div>
  );
}

function RunReport({ runId, refreshKey, onDelete }: { runId: string; refreshKey?: string; onDelete: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void api.run(runId).then(setRun); }, [runId, refreshKey]);
  // Refresco en vivo mientras la ejecución sigue activa
  useEffect(() => {
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    const t = setTimeout(() => void api.run(runId).then(setRun), 800);
    return () => clearTimeout(t);
  }, [run, runId]);
  if (!run) return <p className="muted">Cargando…</p>;
  const s = run.summary;
  const dur = s ? `${(s.durationMs / 1000).toFixed(2)} s` : "—";
  const isUi = run.kind === "ui";
  const isLoad = run.kind === "load";
  const isSec = run.kind === "security";

  return (
    <div className="report">
      <div className="row">
        <h2>Reporte de ejecución {isUi ? "UI" : isLoad ? "de carga" : isSec ? "de seguridad" : "API"}</h2>
        <StatusBadge status={run.status} />
        <span className="grow" />
        <a className="btn ghost" href={`/api/runs/${run.id}/junit.xml`} download={`testforge-${run.id}.xml`}>Descargar JUnit XML</a>
        <button className="btn danger ghost" disabled={run.status === "queued" || run.status === "running"} onClick={onDelete}>Eliminar</button>
      </div>
      <p className="muted small">
        {run.projectName} · entorno: {run.environmentName ?? "ninguno"} · lanzada: {new Date(run.createdAt).toLocaleString()} · disparador: {run.trigger}
        {isUi && run.options.browsers && <> · navegadores: {run.options.browsers.map((b) => BROWSER_LABELS[b]).join(", ")}</>}
      </p>
      {run.error && <div className="banner error">{run.error}</div>}
      {isLoad && <LoadReportBlock runId={run.id} report={(run.summary as { load?: LoadReport } | null)?.load ?? null} run={run} />}
      {isSec && <SecurityReportView run={run} report={(run.summary as { security?: SecurityReport } | null)?.security ?? { targetUrl: "", mode: "passive", durationSec: 0, urlsScanned: 0, counts: { high: 0, medium: 0, low: 0, informational: 0 }, findings: [], stoppedEarly: false }} />}
      {!isLoad && !isSec && (<>
      <div className="tiles">
        <Tile label="Total" value={s?.total ?? run.results.length} />
        <Tile label="Pasaron" value={s?.passed ?? run.results.filter((r) => r.status === "passed").length} tone="ok" />
        <Tile label="Fallaron" value={s?.failed ?? run.results.filter((r) => r.status === "failed").length} tone="ko" />
        <Tile label="Errores" value={s?.errors ?? run.results.filter((r) => r.status === "error").length} tone="warn" />
        <Tile label="Duración" value={dur} />
      </div>
      <table className="results-table">
        <thead>
          {isUi
            ? <tr><th>#</th><th>Prueba</th><th>Estado</th><th>Navegador</th><th>Tiempo</th><th>Detalle</th></tr>
            : <tr><th>#</th><th>Request</th><th>Estado</th><th>HTTP</th><th>Tiempo</th><th>Aserciones</th></tr>}
        </thead>
        <tbody>
          {run.results.map((r) => (
            <Fragment key={r.id}>
              <tr className={`clickable ${open === r.id ? "open" : ""}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                <td>{r.position + 1}</td>
                {r.kind === "ui" ? (
                  <>
                    <td><span className="method m-UI">UI</span> {r.name}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>
                      {BROWSER_LABELS[r.browser as UiBrowser] ?? r.browser}
                      {(() => { const e = engineFromUA(r.userAgent); return e
                        ? <div className={`engine-tag engine-${e.engine} mini`}>{e.label}{e.version ? ` ${e.version.split(".")[0]}` : ""}</div>
                        : null; })()}
                    </td>
                    <td>{r.durationMs} ms</td>
                    <td className="muted small">{r.error ? r.error.split("\n")[0].slice(0, 70) : `${r.attachments.length} adjuntos`}</td>
                  </>
                ) : (
                  <>
                    <td><span className={`method m-${r.request?.method}`}>{r.request?.method}</span> {r.name}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{r.response?.status ?? "—"}</td>
                    <td>{r.durationMs} ms</td>
                    <td>{r.assertions.filter((a) => a.passed).length}/{r.assertions.length}</td>
                  </>
                )}
              </tr>
              {open === r.id && (
                <tr className="detail"><td colSpan={6}>
                  {r.kind === "ui" ? <UiResultView result={r} /> : <ResultView result={r as RequestResult} />}
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {(run.status === "queued" || run.status === "running") && <p className="muted">Ejecutando… los resultados aparecen a medida que terminan.</p>}
      </>)}
    </div>
  );
}

function LoadReportBlock({ runId, report, run }: { runId: string; report: LoadReport | null; run: RunDetail }) {
  const [samples, setSamples] = useState<LoadSample[]>([]);
  useEffect(() => { void api.samples(runId).then(setSamples).catch(() => {}); }, [runId]);
  return <LoadDashboard run={run} samples={samples} report={report} live={false} />;
}

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "ko" | "warn" }) {
  return <div className={`tile ${tone ?? ""}`}><div className="tile-value">{value}</div><div className="tile-label">{label}</div></div>;
}
