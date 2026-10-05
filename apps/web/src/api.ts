import type { ApiRequestInput, LoadConfig, LoadReport, LoadSample, RequestResult, RunKind, RunStatus, RunSummary, SecurityConfig, SecurityReport, UiAttachment, UiBrowser, UiStep, UiTestInput } from "@testforge/shared";

export type Project = { id: string; name: string; baseUrl: string; uiBaseUrl: string; requestCount?: number; uiTestCount?: number };
export type UiTest = UiTestInput & { id: string; projectId: string };
export type Environment = { id: string; projectId: string; name: string; variables: Record<string, string> };
export type SavedRequest = ApiRequestInput & { id: string; projectId: string };
export type Run = {
  id: string; projectId: string; environmentId: string | null; environmentName?: string | null;
  status: RunStatus; trigger: string; kind: RunKind;
  options: { browsers?: UiBrowser[]; testIds?: string[] | null; load?: LoadConfig; security?: SecurityConfig }; summary: RunSummary | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};
export type StoredResult = Omit<RequestResult, "request"> & {
  id: string; position: number; kind: RunKind; browser: string | null;
  request: RequestResult["request"] | null;
  attachments: UiAttachment[]; steps: UiStep[];
};
export type RunDetail = Run & { projectName: string; results: StoredResult[] };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Ruta inexistente: la web es más nueva que la API que está corriendo
    if (res.status === 404 && typeof data.message === "string" && data.message.startsWith("Route ")) {
      throw new Error("La API en ejecución está desactualizada. Detén pnpm dev (Ctrl + C) y vuelve a ejecutarlo.");
    }
    const issues = (data.issues as { path: string[]; message: string }[] | undefined)
      ?.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ");
    throw new Error(issues ? `${data.error}: ${issues}` : data.error ?? `Error ${res.status}`);
  }
  return data as T;
}

export const api = {
  projects: () => call<Project[]>("GET", "/projects"),
  createProject: (d: { name: string; baseUrl: string; uiBaseUrl?: string }) => call<Project>("POST", "/projects", d),
  updateProject: (id: string, d: { name: string; baseUrl: string; uiBaseUrl: string }) => call<Project>("PUT", `/projects/${id}`, d),
  deleteProject: (id: string) => call<void>("DELETE", `/projects/${id}`),

  environments: (pid: string) => call<Environment[]>("GET", `/projects/${pid}/environments`),
  createEnvironment: (pid: string, d: { name: string; variables: Record<string, string> }) =>
    call<Environment>("POST", `/projects/${pid}/environments`, d),
  updateEnvironment: (id: string, d: { name: string; variables: Record<string, string> }) =>
    call<Environment>("PUT", `/environments/${id}`, d),
  deleteEnvironment: (id: string) => call<void>("DELETE", `/environments/${id}`),

  requests: (pid: string) => call<SavedRequest[]>("GET", `/projects/${pid}/requests`),
  createRequest: (pid: string, d: ApiRequestInput) => call<SavedRequest>("POST", `/projects/${pid}/requests`, d),
  updateRequest: (id: string, d: ApiRequestInput) => call<SavedRequest>("PUT", `/requests/${id}`, d),
  deleteRequest: (id: string) => call<void>("DELETE", `/requests/${id}`),
  send: (pid: string, request: ApiRequestInput, environmentId: string | null, sessionVariables: Record<string, string>) =>
    call<RequestResult>("POST", `/projects/${pid}/send`, { request, environmentId, sessionVariables }),
  importCollection: (pid: string, collection: unknown) =>
    call<{ imported: number; format: string; name: string; variables: Record<string, string>; warnings: string[] }>(
      "POST", `/projects/${pid}/import`, { collection }),

  uiTests: (pid: string) => call<UiTest[]>("GET", `/projects/${pid}/ui-tests`),
  createUiTest: (pid: string, d: UiTestInput) => call<UiTest>("POST", `/projects/${pid}/ui-tests`, d),
  updateUiTest: (id: string, d: UiTestInput) => call<UiTest>("PUT", `/ui-tests/${id}`, d),
  deleteUiTest: (id: string) => call<void>("DELETE", `/ui-tests/${id}`),
  recordUiTest: (pid: string, opts: { url?: string; browser?: UiBrowser; name?: string }) =>
    call<UiTest>("POST", `/projects/${pid}/record`, opts),

  runs: (pid: string) => call<Run[]>("GET", `/projects/${pid}/runs`),
  startRun: (pid: string, environmentId: string | null, opts: { kind?: RunKind; browsers?: UiBrowser[]; testIds?: string[]; load?: LoadConfig; security?: SecurityConfig } = {}) =>
    call<Run>("POST", `/projects/${pid}/runs`, { environmentId, ...opts }),
  scanProgress: (id: string) => call<{ progress: { phase: string; percent: number } | null; status: RunStatus | null }>("GET", `/runs/${id}/progress`),
  stopRun: (id: string) => call<{ ok: boolean }>("POST", `/runs/${id}/stop`),
  samples: (id: string) => call<LoadSample[]>("GET", `/runs/${id}/samples`),
  run: (id: string) => call<RunDetail>("GET", `/runs/${id}`),
  deleteRuns: (ids: string[]) => call<{ deleted: string[]; skipped: number }>("POST", "/runs/delete", { ids }),
};

export const artifactUrl = (path: string) => `/api/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`;
