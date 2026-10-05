import { useCallback, useEffect, useState } from "react";
import { httpMethods, type ApiRequestInput, type RequestResult } from "@testforge/shared";
import { api, type Project, type SavedRequest } from "../api";
import { forget, usePersistentState } from "../store";
import { AssertionsEditor, CapturesEditor, KeyValueEditor, ResultView } from "./common";

const blank = (): ApiRequestInput => ({
  name: "Nuevo request", method: "GET", url: "/", headers: {}, body: null,
  assertions: [{ type: "status", equals: 200 }], captures: [], sortOrder: 0,
});

// Plantillas de los requests más usados: al elegir una, se crea el request ya armado.
const TEMPLATES: { label: string; make: () => ApiRequestInput }[] = [
  { label: "GET — listar recursos", make: () => ({
    name: "Listar", method: "GET", url: "/recursos", headers: {}, body: null,
    assertions: [{ type: "status", equals: 200 }, { type: "responseTime", lessThanMs: 1000 }], captures: [], sortOrder: 0 }) },
  { label: "GET — obtener por id", make: () => ({
    name: "Obtener por id", method: "GET", url: "/recursos/{{id}}", headers: {}, body: null,
    assertions: [{ type: "status", equals: 200 }, { type: "jsonPath", path: "id", op: "exists" }], captures: [], sortOrder: 0 }) },
  { label: "POST — crear (JSON)", make: () => ({
    name: "Crear", method: "POST", url: "/recursos", headers: { "Content-Type": "application/json" },
    body: '{\n  "nombre": "ejemplo"\n}',
    assertions: [{ type: "status", equals: 201 }, { type: "jsonPath", path: "id", op: "exists" }], captures: [], sortOrder: 0 }) },
  { label: "PUT — actualizar", make: () => ({
    name: "Actualizar", method: "PUT", url: "/recursos/{{id}}", headers: { "Content-Type": "application/json" },
    body: '{\n  "nombre": "actualizado"\n}',
    assertions: [{ type: "status", equals: 200 }], captures: [], sortOrder: 0 }) },
  { label: "PATCH — actualizar parcial", make: () => ({
    name: "Actualizar parcial", method: "PATCH", url: "/recursos/{{id}}", headers: { "Content-Type": "application/json" },
    body: '{\n  "campo": "valor"\n}',
    assertions: [{ type: "status", equals: 200 }], captures: [], sortOrder: 0 }) },
  { label: "DELETE — eliminar", make: () => ({
    name: "Eliminar", method: "DELETE", url: "/recursos/{{id}}", headers: {}, body: null,
    assertions: [{ type: "status", equals: 204 }], captures: [], sortOrder: 0 }) },
  { label: "Login — guarda el token", make: () => ({
    name: "Login", method: "POST", url: "/login", headers: { "Content-Type": "application/json" },
    body: '{\n  "usuario": "{{usuario}}",\n  "password": "{{password}}"\n}',
    assertions: [{ type: "status", equals: 200 }],
    captures: [{ variable: "token", from: "jsonPath", path: "token" }], sortOrder: 0 }) },
  { label: "Request autenticado (Bearer)", make: () => ({
    name: "Perfil", method: "GET", url: "/perfil", headers: { Authorization: "Bearer {{token}}" }, body: null,
    assertions: [{ type: "status", equals: 200 }], captures: [], sortOrder: 0 }) },
  { label: "Búsqueda con parámetros", make: () => ({
    name: "Buscar", method: "GET", url: "/buscar?q={{termino}}&pagina=1", headers: {}, body: null,
    assertions: [{ type: "status", equals: 200 }, { type: "jsonPath", path: "resultados", op: "exists" }], captures: [], sortOrder: 0 }) },
  { label: "Enviar formulario (urlencoded)", make: () => ({
    name: "Formulario", method: "POST", url: "/formulario", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "campo1=valor1&campo2=valor2",
    assertions: [{ type: "status", equals: 200 }], captures: [], sortOrder: 0 }) },
];

function toInput(r: SavedRequest): ApiRequestInput {
  const { name, method, url, headers, body, assertions, captures, sortOrder } = r;
  return { name, method, url, headers, body, assertions, captures, sortOrder };
}

export function RequestsView({ project, environmentId, onChanged }: {
  project: Project; environmentId: string | null; onChanged: () => void;
}) {
  const [items, setItems] = useState<SavedRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  // Variables capturadas al enviar requests uno a uno (como en Postman)
  const [sessionVars, setSessionVars] = usePersistentState<Record<string, string>>(`vars:${project.id}`, {});

  const load = useCallback(async () => {
    const list = await api.requests(project.id);
    setItems(list);
    setSelectedId((cur) => (list.some((r) => r.id === cur) ? cur : list[0]?.id ?? null));
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  const selected = items.find((r) => r.id === selectedId) ?? null;

  const createFrom = async (input: ApiRequestInput) => {
    const r = await api.createRequest(project.id, input);
    await load();
    setSelectedId(r.id);
    onChanged();
  };
  const create = () => createFrom(blank());

  return (
    <div className="split">
      <div className="list-pane">
        <button className="btn primary full" onClick={create}>+ Nuevo request</button>
        <select className="template-picker" value="" onChange={(e) => {
          const t = TEMPLATES[Number(e.target.value)];
          if (t) void createFrom(t.make());
          e.target.value = "";
        }}>
          <option value="">+ Desde plantilla…</option>
          {TEMPLATES.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
        </select>
        <button className="btn ghost full" onClick={() => setShowImport(true)}>⇪ Importar Postman / OpenAPI</button>
        <p className="muted small">Se ejecutan en este orden. Las variables capturadas pasan al siguiente.</p>
        {Object.keys(sessionVars).length > 0 && (
          <div className="session-vars">
            <div className="row"><b className="small">Variables de sesión</b><span className="grow" />
              <button className="btn ghost small" onClick={() => setSessionVars({})}>Limpiar</button></div>
            {Object.entries(sessionVars).map(([k, v]) => <div key={k} className="mono small" title={v}>{k} = {v.length > 28 ? v.slice(0, 28) + "…" : v}</div>)}
          </div>
        )}
        {items.map((r, i) => (
          <button key={r.id} className={`list-item ${r.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(r.id)}>
            <span className="order">{i + 1}</span>
            <span className={`method m-${r.method}`}>{r.method}</span>
            <span className="name">{r.name}</span>
          </button>
        ))}
      </div>
      <div className="editor-pane">
        {selected ? (
          <RequestEditor
            key={selected.id}
            project={project}
            saved={selected}
            index={items.findIndex((r) => r.id === selected.id)}
            count={items.length}
            environmentId={environmentId}
            sessionVars={sessionVars}
            onCaptured={(v) => setSessionVars((cur) => ({ ...cur, ...v }))}
            onSaved={load}
            onMove={async (dir) => {
              const i = items.findIndex((r) => r.id === selected.id);
              const j = i + dir;
              if (j < 0 || j >= items.length) return;
              const reordered = [...items];
              [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
              await Promise.all(reordered.map((r, k) => api.updateRequest(r.id, { ...toInput(r), sortOrder: k })));
              await load();
            }}
            onDeleted={async () => { await api.deleteRequest(selected.id); forget(`draft:${selected.id}`, `result:${selected.id}`); setSelectedId(null); await load(); onChanged(); }}
          />
        ) : (
          <div className="empty">
            <h2>Sin requests todavía</h2>
            <p>Crea un request, agrega aserciones y pulsa <b>Enviar</b> para probarlo.</p>
          </div>
        )}
      </div>
      {showImport && (
        <ImportDialog project={project} onClose={() => setShowImport(false)}
          onDone={async (firstId) => { setShowImport(false); await load(); if (firstId) setSelectedId(firstId); onChanged(); }} />
      )}
    </div>
  );
}

function ImportDialog({ project, onClose, onDone }: { project: Project; onClose: () => void; onDone: (firstId: string | null) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ imported: number; format: string; variables: Record<string, string>; warnings: string[] } | null>(null);

  const doImport = async () => {
    setError(null); setBusy(true);
    try {
      const json = JSON.parse(text);
      const res = await api.importCollection(project.id, json);
      setDone(res);
    } catch (e) {
      setError(e instanceof SyntaxError ? "El texto no es un JSON válido." : (e as Error).message);
    }
    setBusy(false);
  };
  const onFile = async (f: File) => { setText(await f.text()); };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Importar colección</h3>
        {!done ? (
          <>
            <p className="muted small">Pega el JSON de una colección de <b>Postman v2.1</b> o de un archivo <b>OpenAPI 3</b>, o elige el archivo.</p>
            <input type="file" accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
            <textarea className="mono" rows={10} placeholder='{ "info": { ... }, "item": [ ... ] }' value={text} onChange={(e) => setText(e.target.value)} />
            {error && <div className="banner error">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || !text.trim()} onClick={doImport}>{busy ? "Importando…" : "Importar"}</button>
              <button className="btn ghost" onClick={onClose}>Cancelar</button>
            </div>
          </>
        ) : (
          <>
            <div className="banner info">Se importaron <b>{done.imported}</b> requests ({done.format === "postman" ? "Postman" : "OpenAPI"}).</div>
            {Object.keys(done.variables).length > 0 && (
              <p className="small">Variables sugeridas para tu entorno: {Object.entries(done.variables).map(([k, v]) => <code key={k}>{k}={v || "?"} </code>)}
                <br /><span className="muted">Agrégalas en "Entornos y proyecto" si hace falta.</span></p>
            )}
            {done.warnings.length > 0 && <ul className="err-list">{done.warnings.map((w, i) => <li key={i} className="muted">{w}</li>)}</ul>}
            <div className="row"><button className="btn primary" onClick={() => onDone(null)}>Listo</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function RequestEditor({ project, saved, index, count, environmentId, sessionVars, onCaptured, onSaved, onDeleted, onMove }: {
  project: Project; saved: SavedRequest; index: number; count: number; environmentId: string | null;
  sessionVars: Record<string, string>; onCaptured: (v: Record<string, string>) => void;
  onSaved: () => void; onDeleted: () => void; onMove: (dir: -1 | 1) => void;
}) {
  // Borrador y último resultado se conservan al cambiar de pestaña o recargar
  const [draft, setDraft] = usePersistentState<ApiRequestInput>(`draft:${saved.id}`, () => toInput(saved));
  const [tab, setTab] = useState<"headers" | "body" | "assertions" | "captures">("assertions");
  const [result, setResult] = usePersistentState<RequestResult | null>(`result:${saved.id}`, null);
  const [busy, setBusy] = useState<"send" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // El orden se maneja con ↑ ↓, no cuenta como cambio del borrador
  const dirty = JSON.stringify({ ...draft, sortOrder: 0 }) !== JSON.stringify({ ...toInput(saved), sortOrder: 0 });
  const patch = (p: Partial<ApiRequestInput>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    setBusy("save"); setError(null);
    try { await api.updateRequest(saved.id, { ...draft, sortOrder: saved.sortOrder }); onSaved(); } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };
  const send = async () => {
    setBusy("send"); setError(null);
    try {
      const r = await api.send(project.id, draft, environmentId, sessionVars);
      setResult(r);
      if (Object.keys(r.captured).length) onCaptured(r.captured);
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };

  return (
    <div className="editor">
      <div className="row">
        <input className="title-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        <button className="btn ghost" disabled={index === 0} title="Subir" onClick={() => onMove(-1)}>↑</button>
        <button className="btn ghost" disabled={index === count - 1} title="Bajar" onClick={() => onMove(1)}>↓</button>
        <button className="btn" disabled={!dirty || busy !== null} onClick={save}>{busy === "save" ? "Guardando…" : dirty ? "Guardar" : "Guardado"}</button>
        <button className="btn danger ghost" onClick={() => { if (confirm(`¿Eliminar "${saved.name}"?`)) onDeleted(); }}>Eliminar</button>
      </div>
      <form className="url-bar" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <select value={draft.method} onChange={(e) => patch({ method: e.target.value as ApiRequestInput["method"] })}>
          {httpMethods.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="grow mono" value={draft.url} placeholder="/ruta o https://…" onChange={(e) => patch({ url: e.target.value })} />
        <button className="btn primary" disabled={busy !== null}>{busy === "send" ? "Enviando…" : "Enviar"}</button>
      </form>
      {error && <div className="banner error">{error}</div>}
      <nav className="subtabs">
        <button className={tab === "assertions" ? "active" : ""} onClick={() => setTab("assertions")}>Aserciones ({draft.assertions.length})</button>
        <button className={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>Cabeceras ({Object.keys(draft.headers).length})</button>
        <button className={tab === "body" ? "active" : ""} onClick={() => setTab("body")}>Cuerpo</button>
        <button className={tab === "captures" ? "active" : ""} onClick={() => setTab("captures")}>Capturas ({draft.captures.length})</button>
      </nav>
      <div className="tab-body">
        {tab === "headers" && <KeyValueEditor value={draft.headers} onChange={(headers) => patch({ headers })} />}
        {tab === "body" && (
          <textarea className="mono body-input" rows={10} placeholder='{"usuario": "{{user}}"}'
            value={draft.body ?? ""} onChange={(e) => patch({ body: e.target.value || null })} />
        )}
        {tab === "assertions" && <AssertionsEditor value={draft.assertions} onChange={(assertions) => patch({ assertions })} />}
        {tab === "captures" && <CapturesEditor value={draft.captures} onChange={(captures) => patch({ captures })} />}
      </div>
      <h3>Respuesta</h3>
      {result ? <ResultView result={result} /> : <p className="muted">Pulsa Enviar para ver la respuesta aquí.</p>}
    </div>
  );
}
