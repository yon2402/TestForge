import { useState } from "react";
import type { ScanSeverity, SecurityFinding, SecurityReport } from "@testforge/shared";
import type { Run } from "../api";

const SEV_LABEL: Record<ScanSeverity, string> = { high: "Alta", medium: "Media", low: "Baja", informational: "Informativa" };

export function SecurityReportView({ run, report }: { run: Run; report: SecurityReport }) {
  return (
    <div className="load-dash">
      <div className="load-dash-head">
        <h3>Resultado del escaneo</h3>
        {report.stoppedEarly && <span className="badge error">Detenido antes de tiempo</span>}
        <span className="grow" />
        <a className="btn ghost small" href={`/api/runs/${run.id}/junit.xml`} download={`seguridad-${run.id}.xml`}>Descargar JUnit</a>
      </div>
      <p className="muted small">
        {report.targetUrl} · escaneo {report.mode === "active" ? "activo" : "pasivo"} · {report.urlsScanned} URLs revisadas · {report.durationSec}s
      </p>

      <div className="tiles load-tiles">
        <SevTile sev="high" n={report.counts.high} />
        <SevTile sev="medium" n={report.counts.medium} />
        <SevTile sev="low" n={report.counts.low} />
        <SevTile sev="informational" n={report.counts.informational} />
      </div>

      {report.findings.length === 0 ? (
        <p className="muted">No se encontraron hallazgos. (Un escaneo pasivo corto puede no detectar todo; prueba el activo en un entorno autorizado.)</p>
      ) : (
        <div className="findings">
          {report.findings.map((f, i) => <Finding key={i} f={f} />)}
        </div>
      )}
    </div>
  );
}

function SevTile({ sev, n }: { sev: ScanSeverity; n: number }) {
  return <div className={`tile sev-${sev}`}><div className="tile-value">{n}</div><div className="tile-label">{SEV_LABEL[sev]}</div></div>;
}

function Finding({ f }: { f: SecurityFinding }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`finding sev-${f.severity}`}>
      <button className="finding-head" onClick={() => setOpen(!open)}>
        <span className={`sev-dot sev-${f.severity}`} />
        <b>{f.name}</b>
        {f.count > 1 && <span className="muted small">×{f.count}</span>}
        {f.cwe && <span className="cwe-chip">{f.cwe}</span>}
        <span className="grow" />
        <span className="muted small">{SEV_LABEL[f.severity]}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="finding-body">
          <div className="fb-row"><b>URL:</b> <code>{f.url}</code>{f.param && <> · <b>parámetro:</b> <code>{f.param}</code></>}</div>
          {f.evidence && <div className="fb-row"><b>Evidencia:</b> <code>{f.evidence}</code></div>}
          {f.description && <div className="fb-row"><b>Qué es:</b> <span dangerouslySetInnerHTML={{ __html: sanitize(f.description) }} /></div>}
          {f.solution && <div className="fb-row"><b>Cómo corregirlo:</b> <span dangerouslySetInnerHTML={{ __html: sanitize(f.solution) }} /></div>}
          {f.confidence && <div className="fb-row muted small">Confianza: {f.confidence}</div>}
        </div>
      )}
    </div>
  );
}

// ZAP devuelve descripciones con algo de HTML simple; quitamos etiquetas por seguridad
function sanitize(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
