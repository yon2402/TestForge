import type { LoadReport, LoadSample } from "@testforge/shared";
import type { Run } from "../api";
import { SERIES, TimeChart } from "./LoadCharts";

function Tile({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "ok" | "ko" }) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

// Tablero de una prueba de carga: en vivo (con muestras) y final (con reporte)
export function LoadDashboard({ run, samples, report, live }: {
  run: Run; samples: LoadSample[]; report: LoadReport | null; live: boolean;
}) {
  const last = samples.at(-1);
  // Durante la ejecución mostramos la última muestra; al terminar, el reporte agregado
  const vus = report?.maxVus ?? last?.vus ?? 0;
  const rps = report ? report.avgRps : last?.rps ?? 0;
  const p95 = report ? report.p95Ms : last?.p95Ms ?? 0;
  const errPct = report ? report.errorRatePct : last?.errorRatePct ?? 0;
  const total = report?.totalRequests ?? samples.reduce((s, x) => s + x.rps, 0);

  return (
    <div className="load-dash">
      <div className="load-dash-head">
        <h3>{live ? "En vivo" : "Resultado final"}</h3>
        {live && <span className="pulse">● ejecutando…</span>}
        {report?.stoppedEarly && <span className="badge error">Detenida antes de tiempo</span>}
        {!live && report && <a className="btn ghost small" href={`/api/runs/${run.id}/junit.xml`} download={`carga-${run.id}.xml`}>Descargar JUnit</a>}
      </div>

      <div className="tiles load-tiles">
        <Tile label="Usuarios (máx.)" value={vus} />
        <Tile label={report ? "Peticiones/seg (prom.)" : "Peticiones/seg"} value={rps} />
        <Tile label="p95 latencia" value={`${p95} ms`} />
        <Tile label="Errores" value={`${errPct}%`} tone={errPct > 0 ? "ko" : "ok"} sub={report ? `${report.totalErrors} de ${report.totalRequests}` : undefined} />
        <Tile label="Total peticiones" value={fmtInt(total)} />
      </div>

      {report && report.thresholds.length > 0 && (
        <div className="thresholds">
          {report.thresholds.map((t) => (
            <div key={t.name} className={`threshold ${t.passed ? "ok" : "ko"}`}>
              <span className="mark">{t.passed ? "✓" : "✗"}</span>
              <b>{t.name}</b><span className="muted">esperado {t.limit}</span><span>obtenido {t.actual}</span>
            </div>
          ))}
        </div>
      )}

      <div className="charts">
        <TimeChart samples={samples} unit="req/s" title="Peticiones por segundo" lines={[{ key: "rps", label: "req/s", color: SERIES[0] }]} />
        <TimeChart samples={samples} unit="ms" title="Latencia (percentiles)" lines={[
          { key: "p50Ms", label: "p50", color: SERIES[2] },
          { key: "p95Ms", label: "p95", color: SERIES[0] },
          { key: "p99Ms", label: "p99", color: SERIES[1] },
        ]} />
        <TimeChart samples={samples} unit="usuarios" title="Usuarios virtuales" lines={[{ key: "vus", label: "VUs", color: SERIES[3] }]} />
        <TimeChart samples={samples} unit="%" title="Tasa de error" lines={[{ key: "errorRatePct", label: "% error", color: SERIES[1] }]} />
      </div>

      {report && (
        <>
          <h4>Por request</h4>
          <table className="results-table">
            <thead><tr><th>Request</th><th>Peticiones</th><th>Errores</th><th>prom.</th><th>p95</th><th>p99</th><th>máx.</th></tr></thead>
            <tbody>
              {report.perRequest.map((r, i) => (
                <tr key={i}>
                  <td><span className={`method m-${r.method}`}>{r.method}</span> {r.name}</td>
                  <td>{fmtInt(r.count)}</td>
                  <td className={r.errors ? "err" : ""}>{r.errors}</td>
                  <td>{r.avgMs} ms</td><td>{r.p95Ms} ms</td><td>{r.p99Ms} ms</td><td>{r.maxMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="load-foot">
            <div>
              <h4>Códigos HTTP</h4>
              <div className="codes">
                {Object.entries(report.statusCodes).sort().map(([code, n]) => (
                  <span key={code} className={`code-chip s${String(code)[0]}`}>{code}: {fmtInt(n)}</span>
                ))}
              </div>
            </div>
            {report.topErrors.length > 0 && (
              <div>
                <h4>Errores más comunes</h4>
                <ul className="err-list">
                  {report.topErrors.map((e, i) => <li key={i}><code>{e.message}</code> × {fmtInt(e.count)}</li>)}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const fmtInt = (n: number) => n.toLocaleString("es");
