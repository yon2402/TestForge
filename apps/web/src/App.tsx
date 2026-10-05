import { useCallback, useEffect, useState } from "react";
import { api, type Environment, type Project } from "./api";
import { RequestsView } from "./components/RequestsView";
import { EnvironmentsView } from "./components/EnvironmentsView";
import { RunsView } from "./components/RunsView";
import { UiTestsView } from "./components/UiTestsView";
import { LoadView } from "./components/LoadView";
import { SecurityView } from "./components/SecurityView";

type Tab = "requests" | "ui" | "load" | "security" | "environments" | "runs";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("requests");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? null;

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      setProjects(list);
      setProjectId((cur) => cur ?? list[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError(`No se pudo conectar con la API: ${(e as Error).message}`);
    }
  }, []);

  const loadEnvironments = useCallback(async (pid: string) => {
    const list = await api.environments(pid);
    setEnvironments(list);
    setEnvironmentId((cur) => (list.some((e) => e.id === cur) ? cur : list[0]?.id ?? null));
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { if (projectId) void loadEnvironments(projectId); }, [projectId, loadEnvironments]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Test<span>Forge</span></div>
        <div className="sidebar-title">Proyectos</div>
        {projects.map((p) => (
          <button key={p.id} className={`side-item ${p.id === projectId ? "active" : ""}`} onClick={() => setProjectId(p.id)}>
            {p.name}
            <small>{p.requestCount ?? 0} requests · {p.uiTestCount ?? 0} pruebas UI</small>
          </button>
        ))}
        {creating ? (
          <NewProjectForm
            onCancel={() => setCreating(false)}
            onCreated={async (p) => { setCreating(false); setProjectId(p.id); await loadProjects(); }}
          />
        ) : (
          <button className="btn ghost full" onClick={() => setCreating(true)}>+ Nuevo proyecto</button>
        )}
      </aside>

      <main className="main">
        {error && <div className="banner error">{error}. ¿Está corriendo <code>pnpm dev</code> y Docker?</div>}
        {!project ? (
          <div className="empty">
            <h2>Crea tu primer proyecto</h2>
            <p>Un proyecto agrupa los requests, entornos y ejecuciones de una aplicación.</p>
          </div>
        ) : (
          <>
            <header className="project-header">
              <div>
                <h1>{project.name}</h1>
                <span className="muted">API: <code>{project.baseUrl || "(ninguna)"}</code> · UI: <code>{project.uiBaseUrl || project.baseUrl || "(ninguna)"}</code></span>
              </div>
              <label className="env-picker">
                Entorno
                <select value={environmentId ?? ""} onChange={(e) => setEnvironmentId(e.target.value || null)}>
                  <option value="">Sin entorno</option>
                  {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </label>
            </header>
            <nav className="tabs">
              <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>Requests API</button>
              <button className={tab === "ui" ? "active" : ""} onClick={() => setTab("ui")}>Pruebas UI</button>
              <button className={tab === "load" ? "active" : ""} onClick={() => setTab("load")}>Carga y estrés</button>
              <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>Seguridad</button>
              <button className={tab === "environments" ? "active" : ""} onClick={() => setTab("environments")}>Entornos y proyecto</button>
              <button className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>Ejecuciones y reportes</button>
            </nav>
            {tab === "requests" && (
              <RequestsView key={project.id} project={project} environmentId={environmentId} onChanged={loadProjects} />
            )}
            {tab === "ui" && (
              <UiTestsView key={project.id} project={project} environmentId={environmentId} onChanged={loadProjects} onOpenReports={() => setTab("runs")} />
            )}
            {tab === "load" && (
              <LoadView key={project.id} project={project} environmentId={environmentId} />
            )}
            {tab === "security" && (
              <SecurityView key={project.id} project={project} />
            )}
            {tab === "environments" && (
              <EnvironmentsView
                key={project.id}
                project={project}
                environments={environments}
                onChanged={async () => { await loadEnvironments(project.id); await loadProjects(); }}
                onDeleted={async () => { setProjectId(null); await loadProjects(); }}
              />
            )}
            {tab === "runs" && <RunsView key={project.id} project={project} environmentId={environmentId} />}
          </>
        )}
      </main>
    </div>
  );
}

function NewProjectForm({ onCreated, onCancel }: { onCreated: (p: Project) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="new-project"
      onSubmit={async (e) => {
        e.preventDefault();
        try { onCreated(await api.createProject({ name, baseUrl })); } catch (x) { setErr((x as Error).message); }
      }}
    >
      <input autoFocus placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="URL base (ej. {{host}}/api)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      {err && <div className="error-text">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={!name.trim()}>Crear</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
