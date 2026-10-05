import { writeFile } from "node:fs/promises";
import type { LoadConfig, LoadReport, RunStatus } from "@testforge/shared";

// ---------- Utilidades de salida ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const green = (s: string) => c("32", s), red = (s: string) => c("31", s), yellow = (s: string) => c("33", s);
const dim = (s: string) => c("2", s), bold = (s: string) => c("1", s);
const log = (s = "") => process.stdout.write(s + "\n");
const fail = (msg: string): never => { process.stderr.write(red(`Error: ${msg}`) + "\n"); process.exit(2); };

// ---------- Lectura de argumentos ----------
type Args = { _: string[]; [k: string]: string | boolean | string[] };
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("-") && t !== "-") {
      const key = t.replace(/^-+/, "");
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) a[key] = true;
      else { a[key] = next; i++; }
    } else (a._ as string[]).push(t);
  }
  return a;
}
const str = (a: Args, k: string, d?: string) => (typeof a[k] === "string" ? (a[k] as string) : d);
const num = (a: Args, k: string) => (typeof a[k] === "string" ? Number(a[k]) : undefined);

const apiBase = (a: Args) => (str(a, "api") ?? process.env.TESTFORGE_API ?? "http://localhost:4000").replace(/\/+$/, "");

async function api<T>(a: Args, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(a)}${path}`, {
      method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return fail(`No se pudo conectar con la API en ${apiBase(a)} (${(e as Error).message}). ¿Está corriendo "pnpm dev"?`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) return fail((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

type Project = { id: string; name: string; requestCount: number; uiTestCount: number };
type Run = { id: string; status: RunStatus; kind: string; summary: unknown };

async function resolveProject(a: Args): Promise<Project> {
  const want = str(a, "project") ?? str(a, "p");
  if (!want) return fail("Falta --project <nombre o id>");
  const projects = await api<Project[]>(a, "GET", "/api/projects");
  const byId = projects.find((p) => p.id === want);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name.toLowerCase() === want.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return fail(`Hay varios proyectos llamados "${want}". Usa el id. (${byName.map((p) => p.id).join(", ")})`);
  return fail(`No existe el proyecto "${want}". Proyectos: ${projects.map((p) => p.name).join(", ") || "(ninguno)"}`);
}

async function resolveEnvId(a: Args, projectId: string): Promise<string | null> {
  const want = str(a, "env") ?? str(a, "e");
  if (!want) return null;
  const envs = await api<{ id: string; name: string }[]>(a, "GET", `/api/projects/${projectId}/environments`);
  const found = envs.find((e) => e.name.toLowerCase() === want.toLowerCase() || e.id === want);
  if (!found) return fail(`No existe el entorno "${want}" en el proyecto. Entornos: ${envs.map((e) => e.name).join(", ") || "(ninguno)"}`);
  return found.id;
}

// ---------- Comando: run ----------
async function cmdRun(a: Args) {
  const kind = (str(a, "kind") ?? "api") as "api" | "ui" | "load";
  if (!["api", "ui", "load"].includes(kind)) return fail(`--kind debe ser api, ui o load (recibido "${kind}")`);
  const project = await resolveProject(a);
  const environmentId = await resolveEnvId(a, project.id);

  const payload: Record<string, unknown> = { kind, trigger: "ci", environmentId };
  if (kind === "ui") {
    payload.browsers = (str(a, "browsers") ?? "chromium").split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (kind === "load") {
    const cfg: Partial<LoadConfig> = {
      mode: (str(a, "mode") ?? "load") as LoadConfig["mode"],
      vus: num(a, "vus") ?? 20,
      durationSec: num(a, "duration") ?? 60,
      rampUpSec: num(a, "ramp") ?? 10,
      thinkTimeMs: num(a, "think") ?? 0,
      maxRps: num(a, "max-rps") ?? null,
      validateAssertions: a["no-assert"] ? false : true,
      requestIds: null,
      thresholds: {
        p95Ms: num(a, "p95") ?? null,
        errorRatePct: num(a, "error-rate") ?? null,
        minRps: num(a, "min-rps") ?? null,
      },
    };
    payload.load = cfg;
  }

  log(dim(`→ ${apiBase(a)}  ·  proyecto "${project.name}"  ·  ${kind.toUpperCase()}${environmentId ? "  ·  entorno " + (str(a, "env") ?? str(a, "e")) : ""}`));
  const run = await api<Run>(a, "POST", `/api/projects/${project.id}/runs`, payload);

  // Espera a que termine
  const quiet = Boolean(a.quiet || a.q);
  let r = run;
  const started = Date.now();
  const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  while (r.status === "queued" || r.status === "running") {
    if (!quiet && useColor) process.stdout.write(`\r${spin[i++ % spin.length]} ejecutando… ${Math.round((Date.now() - started) / 1000)}s`);
    await new Promise((res) => setTimeout(res, 1000));
    r = await api<Run>(a, "GET", `/api/runs/${r.id}`);
  }
  if (!quiet && useColor) process.stdout.write("\r\u001b[K");

  // JUnit opcional
  const junitPath = str(a, "junit");
  if (junitPath) {
    const xml = await (await fetch(`${apiBase(a)}/api/runs/${r.id}/junit.xml`)).text();
    await writeFile(junitPath, xml, "utf8");
    log(dim(`JUnit guardado en ${junitPath}`));
  }

  printSummary(r, project, apiBase(a));
  // Código de salida: 0 si pasó, 1 si falló/error
  process.exit(r.status === "passed" ? 0 : 1);
}

function printSummary(r: Run, project: Project, base: string) {
  const s = r.summary as { total?: number; passed?: number; failed?: number; errors?: number; durationMs?: number; load?: LoadReport } | null;
  log();
  const badge = r.status === "passed" ? green("● PASÓ") : r.status === "failed" ? red("● FALLÓ") : yellow("● ERROR");
  log(`${badge}  ${bold(project.name)}  ${dim(`(${r.kind})`)}`);

  if (r.kind === "load" && s?.load) {
    const L = s.load;
    log(`  ${L.totalRequests.toLocaleString("es")} peticiones · ${L.avgRps} req/s prom · p95 ${L.p95Ms} ms · errores ${L.errorRatePct}%`);
    for (const t of L.thresholds) {
      log(`  ${t.passed ? green("✓") : red("✗")} ${t.name}: esperado ${t.limit}, obtenido ${t.actual}`);
    }
    if (L.thresholds.length === 0) log(dim("  (sin umbrales definidos; la prueba pasa por defecto)"));
  } else if (s) {
    log(`  ${s.passed ?? 0} ok · ${s.failed ?? 0} fallidos · ${s.errors ?? 0} errores  ${dim(`(${Math.round((s.durationMs ?? 0) / 1000)}s)`)}`);
  }
  log(dim(`  Reporte: ${base.replace(/:4000$/, ":5173")}  →  Ejecuciones y reportes`));
  log();
}

// ---------- Comando: projects ----------
async function cmdProjects(a: Args) {
  const projects = await api<Project[]>(a, "GET", "/api/projects");
  if (projects.length === 0) return log(dim("No hay proyectos."));
  for (const p of projects) {
    log(`${bold(p.name)}  ${dim(p.id)}`);
    log(dim(`  ${p.requestCount} requests · ${p.uiTestCount} pruebas UI`));
  }
}

// ---------- Ayuda ----------
function help() {
  log(`${bold("TestForge CLI")} — ejecuta tus pruebas desde la terminal o CI

${bold("Uso:")}
  testforge run --project <nombre|id> [opciones]
  testforge projects

${bold("run — opciones comunes:")}
  --project, -p <v>   Proyecto por nombre o id (obligatorio)
  --kind <v>          api | ui | load   (por defecto: api)
  --env, -e <v>       Entorno a usar (por su nombre)
  --junit <archivo>   Guarda el reporte JUnit XML (para CI)
  --api <url>         URL de la API (o variable TESTFORGE_API; por defecto http://localhost:4000)
  --quiet, -q         Sin animación de progreso

${bold("run --kind ui:")}
  --browsers <lista>  chromium,firefox,webkit   (por defecto: chromium)

${bold("run --kind load:")}
  --mode <v>          load | stress | spike | soak   (por defecto: load)
  --vus <n>           Usuarios virtuales (por defecto: 20)
  --duration <seg>    Duración (por defecto: 60)
  --ramp <seg>        Subida (por defecto: 10)
  --max-rps <n>       Límite de peticiones/seg
  --p95 <ms>          Umbral: p95 menor que
  --error-rate <%>    Umbral: error menor que
  --min-rps <n>       Umbral: peticiones/seg mayor que
  --no-assert         No contar aserciones fallidas como error

${bold("Código de salida:")} 0 si la ejecución pasó, 1 si falló o hubo error.

${bold("Ejemplos:")}
  testforge run -p "Mi API" --kind api --junit resultados.xml
  testforge run -p "Mi API" --kind load --vus 100 --duration 120 --p95 800 --error-rate 1
  testforge run -p "Tienda" --kind ui --browsers chromium,firefox`);
}

// ---------- Enrutador ----------
const argv = process.argv.slice(2);
const a = parseArgs(argv);
const cmd = (a._ as string[])[0];

(async () => {
  if (a.help || a.h || !cmd) return help();
  switch (cmd) {
    case "run": return cmdRun(a);
    case "projects": case "ls": return cmdProjects(a);
    default: process.stderr.write(red(`Comando desconocido: ${cmd}`) + "\n"); help(); process.exit(2);
  }
})();
