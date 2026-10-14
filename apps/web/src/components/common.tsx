import { useState } from "react";
import type { Assertion, AssertionResult, Capture, RequestResult, UiAttachment, UiStep } from "@testforge/shared";
import { artifactUrl } from "../api";

// ---------- Editor de pares clave/valor (headers, variables) ----------
export function KeyValueEditor({
  value, onChange, keyLabel = "Nombre", valueLabel = "Valor",
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  keyLabel?: string;
  valueLabel?: string;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => [...Object.entries(value), ["", ""]]);
  const update = (next: [string, string][]) => {
    const trimmed = next.filter(([k, v], i) => k || v || i === next.length - 1);
    if (trimmed.length === 0 || trimmed[trimmed.length - 1][0] || trimmed[trimmed.length - 1][1]) trimmed.push(["", ""]);
    setRows(trimmed);
    onChange(Object.fromEntries(trimmed.filter(([k]) => k.trim())));
  };
  return (
    <table className="kv">
      <thead><tr><th>{keyLabel}</th><th>{valueLabel}</th><th /></tr></thead>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i}>
            <td><input value={k} placeholder={keyLabel} onChange={(e) => update(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} /></td>
            <td><input value={v} placeholder={valueLabel} onChange={(e) => update(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} /></td>
            <td>{(k || v) && <button className="icon" title="Quitar" onClick={() => update(rows.filter((_, j) => j !== i))}>×</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- Editor de aserciones ----------
const assertionDefaults: Record<Assertion["type"], Assertion> = {
  status: { type: "status", equals: 200 },
  responseTime: { type: "responseTime", lessThanMs: 1000 },
  header: { type: "header", name: "content-type", op: "contains", value: "application/json" },
  jsonPath: { type: "jsonPath", path: "data.id", op: "exists" },
  bodyContains: { type: "bodyContains", text: "" },
  jsonSchema: { type: "jsonSchema", schema: { type: "object" } },
};
const assertionLabels: Record<Assertion["type"], string> = {
  status: "Código de estado",
  responseTime: "Tiempo de respuesta",
  header: "Cabecera",
  jsonPath: "Campo JSON",
  bodyContains: "Cuerpo contiene",
  jsonSchema: "Esquema JSON",
};

function parseLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
function showLoose(v: unknown): string {
  return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
}

export function AssertionsEditor({ value, onChange }: { value: Assertion[]; onChange: (v: Assertion[]) => void }) {
  const set = (i: number, a: Assertion) => onChange(value.map((x, j) => (j === i ? a : x)));
  return (
    <div className="assertions">
      {value.length === 0 && <p className="muted">Sin aserciones: el request pasa si responde.</p>}
      {value.map((a, i) => (
        <div className="assertion-row" key={i}>
          <select value={a.type} onChange={(e) => set(i, assertionDefaults[e.target.value as Assertion["type"]])}>
            {Object.entries(assertionLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {a.type === "status" && (
            <>igual a <NumberInput value={a.equals} onChange={(n) => set(i, { ...a, equals: n })} /></>
          )}
          {a.type === "responseTime" && (
            <>menor que <NumberInput value={a.lessThanMs} min={1} onChange={(n) => set(i, { ...a, lessThanMs: n })} /> ms</>
          )}
          {a.type === "header" && (
            <>
              <input value={a.name} placeholder="nombre" onChange={(e) => set(i, { ...a, name: e.target.value })} />
              <select value={a.op} onChange={(e) => set(i, { ...a, op: e.target.value as typeof a.op })}>
                <option value="exists">existe</option><option value="equals">es igual a</option><option value="contains">contiene</option>
              </select>
              {a.op !== "exists" && <input value={a.value ?? ""} placeholder="valor" onChange={(e) => set(i, { ...a, value: e.target.value })} />}
            </>
          )}
          {a.type === "jsonPath" && (
            <>
              <input value={a.path} placeholder="data.items[0].id" onChange={(e) => set(i, { ...a, path: e.target.value })} />
              <select value={a.op} onChange={(e) => set(i, { ...a, op: e.target.value as typeof a.op })}>
                <option value="exists">existe</option><option value="equals">es igual a</option>
                <option value="notEquals">es distinto de</option><option value="contains">contiene</option>
              </select>
              {a.op !== "exists" && (
                <input defaultValue={showLoose(a.value)} placeholder='valor (texto o JSON)' onChange={(e) => set(i, { ...a, value: parseLoose(e.target.value) })} />
              )}
            </>
          )}
          {a.type === "bodyContains" && (
            <input className="grow" value={a.text} placeholder="texto" onChange={(e) => set(i, { ...a, text: e.target.value })} />
          )}
          {a.type === "jsonSchema" && <SchemaInput value={a.schema} onChange={(schema) => set(i, { ...a, schema })} />}
          <button className="icon" title="Quitar" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn ghost" onClick={() => onChange([...value, assertionDefaults.status])}>+ Aserción</button>
    </div>
  );
}

// Campo numérico que permite borrar y reescribir sin que aparezca un 0 delante
function NumberInput({ value, onChange, min = 0 }: { value: number; onChange: (n: number) => void; min?: number }) {
  const [text, setText] = useState(String(value));
  const valid = (t: string) => /^\d+$/.test(t) && Number(t) >= min;
  return (
    <input
      type="text"
      inputMode="numeric"
      className={`short ${valid(text) ? "" : "invalid"}`}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d]/g, "");
        setText(t);
        if (valid(t)) onChange(Number(t));
      }}
      onBlur={() => { if (!valid(text)) setText(String(value)); }}
    />
  );
}

function SchemaInput({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <textarea
      className={`grow mono ${bad ? "invalid" : ""}`}
      rows={5}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try { onChange(JSON.parse(e.target.value)); setBad(false); } catch { setBad(true); }
      }}
    />
  );
}

export function CapturesEditor({ value, onChange }: { value: Capture[]; onChange: (v: Capture[]) => void }) {
  const set = (i: number, c: Capture) => onChange(value.map((x, j) => (j === i ? c : x)));
  return (
    <div className="assertions">
      <p className="muted">Guarda un valor de la respuesta como variable para usarlo en los siguientes requests con <code>{"{{variable}}"}</code>.</p>
      {value.map((c, i) => (
        <div className="assertion-row" key={i}>
          <input value={c.variable} placeholder="variable" onChange={(e) => set(i, { ...c, variable: e.target.value })} />
          desde
          <select value={c.from} onChange={(e) => set(i, { ...c, from: e.target.value as Capture["from"] })}>
            <option value="jsonPath">campo JSON</option><option value="header">cabecera</option>
          </select>
          <input value={c.path} placeholder={c.from === "header" ? "x-auth-token" : "data.token"} onChange={(e) => set(i, { ...c, path: e.target.value })} />
          <button className="icon" title="Quitar" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn ghost" onClick={() => onChange([...value, { variable: "", from: "jsonPath", path: "" }])}>+ Captura</button>
    </div>
  );
}

// ---------- Vista de un resultado (usada en "Enviar" y en el reporte) ----------
export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    passed: "Pasó", failed: "Falló", error: "Error", queued: "En cola", running: "Ejecutando",
  };
  return <span className={`badge ${status}`}>{labels[status] ?? status}</span>;
}

function prettyBody(r: RequestResult["response"]): string {
  if (!r) return "";
  if (r.json !== undefined) return JSON.stringify(r.json, null, 2);
  return r.body;
}

export function AssertionList({ items }: { items: AssertionResult[] }) {
  if (items.length === 0) return <p className="muted">Sin aserciones.</p>;
  return (
    <ul className="assertion-results">
      {items.map((a, i) => (
        <li key={i} className={a.passed ? "ok" : "ko"}>
          <span className="mark">{a.passed ? "✓" : "✗"}</span>
          <span>{a.message}</span>
          {!a.passed && (a.expected !== undefined || a.actual !== undefined) && (
            <div className="diff">
              <div><b>Esperado:</b> <code>{JSON.stringify(a.expected)}</code></div>
              <div><b>Obtenido:</b> <code>{JSON.stringify(a.actual)?.slice(0, 500)}</code></div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ResultView({ result }: { result: RequestResult }) {
  const [tab, setTab] = useState<"assertions" | "body" | "headers" | "request">("assertions");
  const r = result.response;
  return (
    <div className="result">
      <div className="result-head">
        <StatusBadge status={result.status} />
        {r && <span className={`http-status s${String(r.status)[0]}`}>{r.status} {r.statusText}</span>}
        <span className="muted">{result.durationMs} ms</span>
        {r && <span className="muted">{formatBytes(r.sizeBytes)}{r.truncated ? " (recortado)" : ""}</span>}
      </div>
      {result.error && <div className="banner error">{result.error}</div>}
      <nav className="subtabs">
        <button className={tab === "assertions" ? "active" : ""} onClick={() => setTab("assertions")}>
          Aserciones ({result.assertions.filter((a) => a.passed).length}/{result.assertions.length})
        </button>
        <button className={tab === "body" ? "active" : ""} onClick={() => setTab("body")}>Cuerpo</button>
        <button className={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>Cabeceras</button>
        <button className={tab === "request" ? "active" : ""} onClick={() => setTab("request")}>Request enviado</button>
      </nav>
      {tab === "assertions" && <AssertionList items={result.assertions} />}
      {tab === "body" && <pre className="code">{r ? prettyBody(r) || "(vacío)" : "Sin respuesta"}</pre>}
      {tab === "headers" && (
        <pre className="code">{r ? Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "Sin respuesta"}</pre>
      )}
      {tab === "request" && (
        <pre className="code">
          {`${result.request.method} ${result.request.url}\n`}
          {Object.entries(result.request.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}
          {result.request.body ? `\n\n${result.request.body}` : ""}
          {Object.keys(result.captured ?? {}).length > 0 && `\n\n# Variables capturadas\n${JSON.stringify(result.captured, null, 2)}`}
        </pre>
      )}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Deduce el motor de renderizado real a partir del User-Agent del navegador.
// Chrome/Chromium → Blink; Firefox → Gecko; Safari/WebKit → WebKit.
// (El UA de Chrome también contiene "Safari", por eso Firefox y Chrome se revisan antes.)
export function engineFromUA(ua: string | null | undefined): { engine: string; label: string; version: string | null } | null {
  if (!ua) return null;
  const v = (re: RegExp) => ua.match(re)?.[1] ?? null;
  if (/Firefox\//.test(ua)) return { engine: "gecko", label: "Gecko", version: v(/Firefox\/([\d.]+)/) };
  if (/Edg\//.test(ua)) return { engine: "blink", label: "Blink", version: v(/Edg\/([\d.]+)/) };
  if (/Chrome\//.test(ua)) return { engine: "blink", label: "Blink", version: v(/Chrome\/([\d.]+)/) };
  if (/AppleWebKit\//.test(ua)) return { engine: "webkit", label: "WebKit", version: v(/Version\/([\d.]+)/) };
  return { engine: "otro", label: "Motor", version: null };
}

// ---------- Resultado de una prueba UI: motor real, error, pasos, captura, video y traza ----------
export function UiResultView({ result }: { result: { error: string | null; steps: UiStep[]; attachments: UiAttachment[]; status: string; userAgent?: string | null; browser?: string | null; code?: string | null } }) {
  const eng = engineFromUA(result.userAgent);
  const shot = result.attachments.find((a) => a.contentType === "image/png");
  const video = result.attachments.find((a) => a.contentType.startsWith("video/"));
  const trace = result.attachments.find((a) => a.name === "trace");
  const context = result.attachments.find((a) => a.name === "error-context");
  const traceAbs = trace ? `${window.location.origin}${artifactUrl(trace.path)}` : null;
  const steps = result.steps.filter((s) => !/^(Before|After) Hooks$/.test(s.title));
  return (
    <div className="ui-result">
      {result.userAgent ? (
        <div className="engine-proof">
          {eng && <span className={`engine-tag engine-${eng.engine}`}>Motor {eng.label}{eng.version ? ` ${eng.version}` : ""}</span>}
          <span className="muted small">Ejecutado de verdad en este motor — User-Agent del navegador:</span>
          <code className="ua-string">{result.userAgent}</code>
        </div>
      ) : (
        <div className="engine-proof muted small">
          No se capturó el User-Agent (la prueba no llegó a abrir una página en el navegador).
        </div>
      )}
      {result.code && (
        <details className="code-run" open={result.status !== "passed"}>
          <summary>Código ejecutado</summary>
          <pre className="code code-block"><code>{result.code}</code></pre>
        </details>
      )}
      {result.error && <pre className="code error-pre">{result.error}</pre>}
      {steps.length > 0 ? (
        <details className="steps" open>
          <summary>Pasos ejecutados ({steps.length})</summary>
          <ol className="steps-list">
            {steps.map((s, i) => (
              <li key={i} className={s.error ? "ko" : "ok"}>
                <span className="step-mark">{s.error ? "✗" : "✓"}</span>
                <span className="step-title">{s.title}</span>
                <span className="muted step-time">{s.durationMs} ms</span>
                {s.error && <div className="step-error">{s.error.split("\n")[0]}</div>}
              </li>
            ))}
          </ol>
        </details>
      ) : (
        result.status === "passed" && <p className="muted small">La prueba pasó. No se registraron pasos (código sin acciones de Playwright).</p>
      )}
      <div className="media">
        {shot && (
          <figure>
            <a href={artifactUrl(shot.path)} target="_blank" rel="noreferrer"><img src={artifactUrl(shot.path)} alt="Captura de pantalla" /></a>
            <figcaption>Captura {result.status === "passed" ? "final" : "al fallar"}</figcaption>
          </figure>
        )}
        {video && (
          <figure>
            <video src={artifactUrl(video.path)} controls preload="metadata" />
            <figcaption>Video de la ejecución</figcaption>
          </figure>
        )}
      </div>
      {(trace || context) && (
        <div className="row">
          {traceAbs && (
            <a className="btn" href={`https://trace.playwright.dev/?trace=${encodeURIComponent(traceAbs)}`} target="_blank" rel="noreferrer">
              Abrir traza paso a paso
            </a>
          )}
          {trace && <a className="btn ghost" href={artifactUrl(trace.path)} download>Descargar traza (.zip)</a>}
          {context && <a className="btn ghost" href={artifactUrl(context.path)} target="_blank" rel="noreferrer">Estado de la página al fallar</a>}
        </div>
      )}
    </div>
  );
}
