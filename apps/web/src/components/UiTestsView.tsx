import { useCallback, useEffect, useState } from "react";
import { uiBrowsers, type UiBrowser, type UiTestInput } from "@testforge/shared";
import { api, type Project, type RunDetail, type UiTest } from "../api";
import { CodeEditor } from "./CodeEditor";
import { forget, usePersistentState } from "../store";
import { StatusBadge, engineFromUA } from "./common";

const STARTER = `await page.goto("/");
await expect(page).toHaveTitle(/.+/);
`;

const SNIPPETS: { label: string; code: string }[] = [
  { label: "Ir a una página", code: `await page.goto("/ruta");` },
  { label: "Llenar formulario", code: `await page.getByLabel("Usuario").fill(vars.usuario);\nawait page.getByLabel("Contraseña").fill(vars.password);\nawait page.getByRole("button", { name: "Entrar" }).click();` },
  { label: "Verificar texto visible", code: `await expect(page.getByText("Bienvenido")).toBeVisible();` },
  { label: "Verificar URL", code: `await expect(page).toHaveURL(/\\/inicio/);` },
  { label: "Verificar título", code: `await expect(page).toHaveTitle("Mi aplicación");` },
  { label: "Contar elementos", code: `await expect(page.locator(".producto")).toHaveCount(3);` },
  { label: "Seleccionar opción", code: `await page.getByLabel("País").selectOption("Colombia");` },
  { label: "Paso con nombre", code: `await test.step("Agregar al carrito", async () => {\n  await page.getByRole("button", { name: "Agregar" }).click();\n});` },
];

// Líneas de Playwright más usadas: clic para insertarlas al final del código
const CHEATSHEET: { title: string; items: { code: string; hint: string }[] }[] = [
  { title: "Navegar", items: [
    { code: `await page.goto("/ruta");`, hint: "Abrir una página (se une a la URL base de UI)" },
    { code: `await page.goBack();`, hint: "Volver a la página anterior" },
    { code: `await page.reload();`, hint: "Recargar la página" },
  ] },
  { title: "Encontrar elementos", items: [
    { code: `page.getByRole("button", { name: "Entrar" })`, hint: "Botón, enlace, casilla… por su texto" },
    { code: `page.getByLabel("Usuario")`, hint: "Campo por su etiqueta" },
    { code: `page.getByPlaceholder("Buscar")`, hint: "Campo por su texto de ayuda" },
    { code: `page.getByText("Bienvenido")`, hint: "Cualquier elemento por su texto" },
    { code: `page.getByTestId("carrito")`, hint: "Por el atributo data-testid" },
    { code: `page.locator("#id .clase")`, hint: "Por selector CSS" },
  ] },
  { title: "Acciones", items: [
    { code: `await page.getByRole("button", { name: "Guardar" }).click();`, hint: "Hacer clic" },
    { code: `await page.getByLabel("Email").fill(vars.email);`, hint: "Escribir en un campo" },
    { code: `await page.getByLabel("País").selectOption("Colombia");`, hint: "Elegir en una lista" },
    { code: `await page.getByLabel("Acepto los términos").check();`, hint: "Marcar una casilla" },
    { code: `await page.keyboard.press("Enter");`, hint: "Pulsar una tecla" },
    { code: `await page.getByText("Menú").hover();`, hint: "Pasar el mouse por encima" },
    { code: `await page.getByLabel("Archivo").setInputFiles("ruta/archivo.pdf");`, hint: "Subir un archivo" },
  ] },
  { title: "Verificar", items: [
    { code: `await expect(page.getByText("Guardado")).toBeVisible();`, hint: "Que algo se vea" },
    { code: `await expect(page.getByText("Error")).toBeHidden();`, hint: "Que algo no se vea" },
    { code: `await expect(page.locator("#total")).toHaveText("$100");`, hint: "Texto exacto de un elemento" },
    { code: `await expect(page.locator("#total")).toContainText("100");`, hint: "Que el texto contenga algo" },
    { code: `await expect(page.getByLabel("Nombre")).toHaveValue("Ana");`, hint: "Valor de un campo" },
    { code: `await expect(page).toHaveURL(/\\/inicio/);`, hint: "La URL actual" },
    { code: `await expect(page).toHaveTitle("Mi aplicación");`, hint: "El título de la pestaña" },
    { code: `await expect(page.locator(".producto")).toHaveCount(3);`, hint: "Cuántos elementos hay" },
    { code: `await expect(page.getByRole("button", { name: "Pagar" })).toBeEnabled();`, hint: "Que un botón esté habilitado" },
  ] },
  { title: "Esperas y otros", items: [
    { code: `await page.waitForURL("**/inicio");`, hint: "Esperar a llegar a una página" },
    { code: `await page.waitForResponse((r) => r.url().includes("/api/") && r.ok());`, hint: "Esperar una respuesta de la API" },
    { code: `const texto = await page.locator("#total").textContent();`, hint: "Leer un texto para usarlo después" },
    { code: `await test.step("Nombre del paso", async () => {\n  // acciones del paso\n});`, hint: "Agrupar acciones en un paso del reporte" },
  ] },
];

function CheatSheet({ onInsert }: { onInsert: (code: string) => void }) {
  return (
    <div className="cheatsheet">
      {CHEATSHEET.map((g) => (
        <section key={g.title} className="cheat-group">
          <h4>{g.title}</h4>
          {g.items.map((it) => (
            <button key={it.code} className="cheat-item" title="Clic para insertar al final del código" onClick={() => onInsert(it.code)}>
              <code>{it.code.split("\n")[0]}{it.code.includes("\n") ? " …" : ""}</code>
              <span>{it.hint}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

export const BROWSER_LABELS: Record<UiBrowser, string> = { chromium: "Chrome", firefox: "Firefox", webkit: "Safari" };

export function BrowserPicker({ value, onChange }: { value: UiBrowser[]; onChange: (v: UiBrowser[]) => void }) {
  return (
    <span className="browser-picker">
      {uiBrowsers.map((b) => (
        <label key={b}>
          <input
            type="checkbox"
            checked={value.includes(b)}
            onChange={(e) => {
              const next = e.target.checked ? [...value, b] : value.filter((x) => x !== b);
              if (next.length) onChange(uiBrowsers.filter((x) => next.includes(x)));
            }}
          />
          {BROWSER_LABELS[b]}
        </label>
      ))}
    </span>
  );
}

export function UiTestsView({ project, environmentId, onChanged, onOpenReports }: {
  project: Project; environmentId: string | null; onChanged: () => void; onOpenReports: () => void;
}) {
  const [items, setItems] = useState<UiTest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<UiBrowser[]>(["chromium"]);
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api.uiTests(project.id);
    setItems(list);
    setSelectedId((cur) => (list.some((t) => t.id === cur) ? cur : list[0]?.id ?? null));
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  const selected = items.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="split">
      <div className="list-pane">
        <button className="btn primary full" onClick={async () => {
          const t = await api.createUiTest(project.id, { name: "Nueva prueba UI", code: STARTER, sortOrder: 0 });
          await load(); setSelectedId(t.id); onChanged();
        }}>+ Nueva prueba UI</button>
        <button className="btn ghost full" disabled={recording} onClick={async () => {
          setRecError(null); setRecording(true);
          try {
            const t = await api.recordUiTest(project.id, { browser: "chromium" });
            await load(); setSelectedId(t.id); onChanged();
          } catch (e) { setRecError((e as Error).message); }
          setRecording(false);
        }}>{recording ? "● Grabando… (cierra la ventana al terminar)" : "⦿ Grabar prueba"}</button>
        {recording && <p className="muted small">Se abrió un navegador en esta máquina. Navega y haz clics; al cerrar la ventana, los pasos se guardan como una prueba.</p>}
        {recError && <div className="banner error">{recError}</div>}
        <p className="muted small">
          URL base de UI: <code>{project.uiBaseUrl || project.baseUrl || "(definir en Entornos y proyecto)"}</code>
        </p>
        {items.map((t, i) => (
          <button key={t.id} className={`list-item ${t.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(t.id)}>
            <span className="order">{i + 1}</span>
            <span className="method m-UI">UI</span>
            <span className="name">{t.name}</span>
          </button>
        ))}
      </div>
      <div className="editor-pane">
        {selected ? (
          <UiTestEditor
            key={selected.id}
            project={project}
            saved={selected}
            environmentId={environmentId}
            browsers={browsers}
            onBrowsers={setBrowsers}
            onOpenReports={onOpenReports}
            onSaved={load}
            onDeleted={async () => { await api.deleteUiTest(selected.id); forget(`uidraft:${selected.id}`, `uirun:${selected.id}`); setSelectedId(null); await load(); onChanged(); }}
          />
        ) : (
          <div className="empty">
            <h2>Sin pruebas UI todavía</h2>
            <p>Crea una prueba, escribe los pasos con sintaxis de Playwright y ejecútala en Chrome, Firefox o Safari.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function UiTestEditor({ project, saved, environmentId, browsers, onBrowsers, onOpenReports, onSaved, onDeleted }: {
  project: Project; saved: UiTest; environmentId: string | null; browsers: UiBrowser[];
  onBrowsers: (b: UiBrowser[]) => void; onOpenReports: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const toInput = (t: UiTest): UiTestInput => ({ name: t.name, code: t.code, sortOrder: t.sortOrder });
  const [draft, setDraft] = usePersistentState<UiTestInput>(`uidraft:${saved.id}`, () => toInput(saved));
  // Se guarda solo el id de la última ejecución; el resultado se vuelve a pedir a la API
  const [lastRunId, setLastRunId] = usePersistentState<string | null>(`uirun:${saved.id}`, null);
  const [run, setRun] = useState<RunDetail | null>(null);
  useEffect(() => {
    if (lastRunId && !run) void api.run(lastRunId).then(setRun).catch(() => setLastRunId(null));
  }, [lastRunId, run, setLastRunId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const dirty = draft.name !== saved.name || draft.code !== saved.code;

  // Mientras la ejecución esté activa, consulta su estado
  useEffect(() => {
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    const t = setTimeout(() => void api.run(run.id).then(setRun), 1000);
    return () => clearTimeout(t);
  }, [run]);

  const save = async () => { await api.updateUiTest(saved.id, draft); onSaved(); };
  const execute = async () => {
    setError(null); setBusy(true);
    try {
      if (dirty) await save();
      const r = await api.startRun(project.id, environmentId, { kind: "ui", browsers, testIds: [saved.id] });
      setLastRunId(r.id);
      setRun(await api.run(r.id));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const running = run?.status === "queued" || run?.status === "running";
  const insert = (code: string) => {
    setDraft((d) => ({ ...d, code: d.code.replace(/\s*$/, "") + "\n" + code + "\n" }));
    setEditorKey((k) => k + 1);
  };

  return (
    <div className="editor">
      <div className="row">
        <input className="title-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <button className="btn" disabled={!dirty} onClick={save}>{dirty ? "Guardar" : "Guardado"}</button>
        <button className="btn danger ghost" onClick={() => { if (confirm(`¿Eliminar "${saved.name}"?`)) onDeleted(); }}>Eliminar</button>
      </div>
      <div className="row">
        <select value="" onChange={(e) => {
          const s = SNIPPETS[Number(e.target.value)];
          if (!s) return;
          insert(s.code);
        }}>
          <option value="">+ Insertar paso…</option>
          {SNIPPETS.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
        </select>
        <span className="grow" />
        <BrowserPicker value={browsers} onChange={onBrowsers} />
        <button className="btn primary" disabled={busy || running} onClick={execute}>
          {running ? "Ejecutando…" : "▶ Ejecutar prueba"}
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      <CodeEditor key={editorKey} value={draft.code} onChange={(code) => setDraft((d) => ({ ...d, code }))} />
      {run && (
        <div className="run-status">
          {running ? (
            <span className="muted">
              Ejecutando en {run.options.browsers?.map((b) => BROWSER_LABELS[b]).join(", ")}… (el primer arranque del navegador tarda unos segundos)
            </span>
          ) : (
            <>
              <span className="muted">Última ejecución:</span>
              {run.error && <StatusBadge status="error" />}
              {run.results.map((r) => (
                <span key={r.id} className="run-status-item" title={r.userAgent ?? r.error ?? ""}>
                  <StatusBadge status={r.status} /> {BROWSER_LABELS[r.browser as UiBrowser] ?? r.browser}
                  {(() => { const e = engineFromUA(r.userAgent); return e
                    ? <span className={`engine-tag engine-${e.engine} mini`} style={{ marginLeft: 6 }}>{e.label}</span>
                    : null; })()}
                </span>
              ))}
            </>
          )}
          <span className="grow" />
          <button className="btn ghost small" onClick={onOpenReports}>Ver reporte completo →</button>
        </div>
      )}

      <div className="guide">
        <p><b>Cómo escribir la prueba:</b> usa la sintaxis de Playwright, una acción por línea con <code>await</code>.</p>
        <p>
          Disponibles: <code>page</code> (la página), <code>expect</code> (verificaciones), <code>context</code>,{" "}
          <code>request</code> y <code>vars</code> (variables del entorno, por ejemplo <code>vars.usuario</code>).
        </p>
        <p>
          Guía de sintaxis: <a href="https://playwright.dev/docs/writing-tests" target="_blank" rel="noreferrer">playwright.dev/docs/writing-tests</a>
          {" · "}Localizadores recomendados: <code>getByRole</code>, <code>getByLabel</code>, <code>getByText</code>.
        </p>
      </div>

      <h3>Líneas más usadas <span className="muted small">(clic para insertar al final del código)</span></h3>
      <CheatSheet onInsert={insert} />
    </div>
  );
}
