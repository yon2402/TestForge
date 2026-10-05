import { useState } from "react";
import { api, type Environment, type Project } from "../api";
import { KeyValueEditor } from "./common";

export function EnvironmentsView({ project, environments, onChanged, onDeleted }: {
  project: Project; environments: Environment[]; onChanged: () => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [baseUrl, setBaseUrl] = useState(project.baseUrl);
  const [uiBaseUrl, setUiBaseUrl] = useState(project.uiBaseUrl ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="stack">
      <section className="card">
        <h3>Proyecto</h3>
        <div className="form-grid">
          <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>URL base de API<input className="mono" value={baseUrl} placeholder="{{host}}/api" onChange={(e) => setBaseUrl(e.target.value)} /></label>
          <span />
          <label>URL base de UI (web)<input className="mono" value={uiBaseUrl} placeholder="{{web}}" onChange={(e) => setUiBaseUrl(e.target.value)} /></label>
        </div>
        <p className="muted small">
          Los requests con ruta relativa (<code>/users</code>) se unen a la URL base de API; en pruebas UI, <code>page.goto("/login")</code> usa la URL base de UI
          (si está vacía, se usa la de API). Ambas aceptan variables del entorno.
        </p>
        <div className="row">
          <button className="btn primary" onClick={async () => { await api.updateProject(project.id, { name, baseUrl, uiBaseUrl }); setMsg("Guardado"); onChanged(); }}>Guardar proyecto</button>
          <button className="btn danger ghost" onClick={async () => {
            if (confirm(`¿Eliminar el proyecto "${project.name}" con todos sus requests y ejecuciones?`)) { await api.deleteProject(project.id); onDeleted(); }
          }}>Eliminar proyecto</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </section>

      <section className="card">
        <h3>Entornos</h3>
        <p className="muted small">Cada entorno define variables (<code>{"{{host}}"}</code>, <code>{"{{user}}"}</code>…) para dev, QA o staging.</p>
        {environments.map((e) => <EnvironmentCard key={e.id} env={e} onChanged={onChanged} />)}
        <button className="btn ghost" onClick={async () => {
          await api.createEnvironment(project.id, { name: environments.length ? `entorno ${environments.length + 1}` : "dev", variables: { host: "http://localhost:3000" } });
          onChanged();
        }}>+ Nuevo entorno</button>
      </section>
    </div>
  );
}

function EnvironmentCard({ env, onChanged }: { env: Environment; onChanged: () => void }) {
  const [name, setName] = useState(env.name);
  const [variables, setVariables] = useState(env.variables);
  const dirty = name !== env.name || JSON.stringify(variables) !== JSON.stringify(env.variables);
  return (
    <div className="env-card">
      <div className="row">
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!dirty} onClick={async () => { await api.updateEnvironment(env.id, { name, variables }); onChanged(); }}>
          {dirty ? "Guardar" : "Guardado"}
        </button>
        <button className="btn danger ghost" onClick={async () => { if (confirm(`¿Eliminar el entorno "${env.name}"?`)) { await api.deleteEnvironment(env.id); onChanged(); } }}>Eliminar</button>
      </div>
      <KeyValueEditor value={variables} onChange={setVariables} keyLabel="Variable" />
    </div>
  );
}
