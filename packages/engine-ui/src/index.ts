import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type Browser = (typeof BROWSERS)[number];

export type UiTestInput = { id: string; name: string; code: string };

export type UiAttachment = { name: string; contentType: string; path: string };
export type UiStep = { title: string; durationMs: number; error: string | null };

export type UiTestResult = {
  testId: string;
  name: string;
  browser: string;
  status: "passed" | "failed" | "error" | "skipped";
  durationMs: number;
  error: string | null;
  errorStack: string | null;
  userAgent: string | null; // User-Agent real del navegador que ejecutó la prueba
  attachments: UiAttachment[]; // rutas relativas a artifactsRoot
  steps: UiStep[];
};

export type UiRunOptions = {
  runId: string;
  tests: UiTestInput[];
  browsers: Browser[];
  baseURL?: string;
  variables?: Record<string, string>;
  /** Carpeta raíz de artefactos; los de esta ejecución van en <artifactsRoot>/<runId> */
  artifactsRoot: string;
  testTimeoutMs?: number;
  runTimeoutMs?: number;
  workers?: number;
  headless?: boolean;
};

const here = dirname(fileURLToPath(import.meta.url));
// Las ejecuciones viven dentro del paquete para que los specs resuelvan @playwright/test
const RUNS_DIR = resolve(here, "../.runs");
const require = createRequire(import.meta.url);

const DEVICES: Record<Browser, string> = {
  chromium: "Desktop Chrome",
  firefox: "Desktop Firefox",
  webkit: "Desktop Safari",
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

export function buildSpec(test: UiTestInput): string {
  const body = test.code
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
  return `import { test, expect } from "@playwright/test";

// Variables del entorno seleccionado: vars.usuario, vars.password…
const vars: Record<string, string> = JSON.parse(process.env.TF_VARS ?? "{}");

// Deja constancia del motor REAL usado (User-Agent del navegador), pase o falle la prueba.
// Así el reporte demuestra que cada navegador es distinto aunque la captura se vea igual.
test.afterEach(async ({ page }, testInfo) => {
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    testInfo.annotations.push({ type: "tf-ua", description: ua });
  } catch {}
});

test(${JSON.stringify(test.name)}, { annotation: { type: "tf-id", description: ${JSON.stringify(test.id)} } }, async ({ page, context, request, baseURL }) => {
${body}
});
`;
}

const SPEC_HEADER_LINES = 15; // líneas del spec antes del código del tester

/** Revisa la sintaxis de una prueba sin ejecutarla. Devuelve el mensaje de error o null. */
export function checkSyntax(test: UiTestInput): string | null {
  const out = ts.transpileModule(buildSpec(test), {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: "prueba.spec.ts",
  });
  const diag = out.diagnostics?.[0];
  if (!diag) return null;
  const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
  if (diag.file && diag.start !== undefined) {
    const { line } = diag.file.getLineAndCharacterOfPosition(diag.start);
    const userLine = Math.min(Math.max(line - SPEC_HEADER_LINES + 1, 1), test.code.split("\n").length + 1);
    return `Error de sintaxis en la línea ${userLine}: ${msg}`;
  }
  return `Error de sintaxis: ${msg}`;
}

export function buildConfig(opts: { outputDir: string; reportFile: string; stepsReporter: string; stepsFile: string;
  browsers: Browser[]; baseURL?: string; testTimeoutMs: number; workers: number; headless: boolean }): string {
  const projects = opts.browsers
    .map((b) => `    { name: ${JSON.stringify(b)}, use: { ...devices[${JSON.stringify(DEVICES[b])}] } },`)
    .join("\n");
  return `import { devices } from "@playwright/test";

export default {
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: ${JSON.stringify(opts.outputDir)},
  timeout: ${opts.testTimeoutMs},
  workers: ${opts.workers},
  retries: 0,
  reporter: [
    ["json", { outputFile: ${JSON.stringify(opts.reportFile)} }],
    [${JSON.stringify(opts.stepsReporter)}, { outputFile: ${JSON.stringify(opts.stepsFile)} }],
  ],
  use: {
    baseURL: ${opts.baseURL ? JSON.stringify(opts.baseURL) : "undefined"},
    headless: ${opts.headless},
    screenshot: "on",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
${projects}
  ],
};
`;
}

type PwStep = { title: string; duration: number; error?: { message?: string }; steps?: PwStep[] };
type PwResult = {
  status: string; duration: number;
  error?: { message?: string; stack?: string };
  errors?: { message?: string; stack?: string }[];
  attachments?: { name: string; contentType: string; path?: string }[];
  steps?: PwStep[];
};
type PwTest = { projectName: string; annotations?: { type: string; description?: string }[]; results: PwResult[] };
type PwSpec = { title: string; tests: PwTest[] };
type PwSuite = { suites?: PwSuite[]; specs?: PwSpec[] };
type PwReport = { suites?: PwSuite[]; errors?: { message?: string; stack?: string }[] };

function collectSpecs(suites: PwSuite[] = [], out: PwSpec[] = []): PwSpec[] {
  for (const s of suites) {
    out.push(...(s.specs ?? []));
    collectSpecs(s.suites, out);
  }
  return out;
}

export function parseReport(report: PwReport, tests: UiTestInput[], browsers: Browser[], artifactsRoot: string, stepsMap?: Map<string, UiStep[]>): UiTestResult[] {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const results: UiTestResult[] = [];
  const seen = new Set<string>();

  for (const spec of collectSpecs(report.suites)) {
    for (const t of spec.tests) {
      const id = t.annotations?.find((a) => a.type === "tf-id")?.description ?? "";
      const userAgent = t.annotations?.find((a) => a.type === "tf-ua")?.description ?? null;
      const r = t.results.at(-1);
      const err = r?.error ?? r?.errors?.[0];
      const status: UiTestResult["status"] = !r ? "skipped"
        : r.status === "passed" ? "passed"
        : r.status === "skipped" ? "skipped"
        : r.status === "interrupted" ? "error" : "failed";
      seen.add(`${id}|${t.projectName}`);
      results.push({
        testId: id,
        name: byId.get(id)?.name ?? spec.title,
        browser: t.projectName,
        status,
        durationMs: Math.round(r?.duration ?? 0),
        error: err?.message ? stripAnsi(err.message).trim() : r?.status === "timedOut" ? "Tiempo de espera agotado" : null,
        errorStack: err?.stack ? stripAnsi(err.stack) : null,
        userAgent,
        attachments: (r?.attachments ?? [])
          .filter((a) => a.path)
          .map((a) => ({ name: a.name, contentType: a.contentType, path: relative(artifactsRoot, a.path!).split(sep).join("/") })),
        steps: stepsMap?.get(`${id}|${t.projectName}`)
          ?? (r?.steps ?? []).map((s) => ({ title: s.title, durationMs: Math.round(s.duration), error: s.error?.message ? stripAnsi(s.error.message) : null })),
      });
    }
  }

  // Si un spec no compiló (error de sintaxis), Playwright no lo reporta como test: lo marcamos como error
  const globalError = (report.errors ?? []).map((e) => stripAnsi(e.message ?? "")).join("\n").trim();
  for (const t of tests) {
    for (const b of browsers) {
      if (seen.has(`${t.id}|${b}`)) continue;
      results.push({ testId: t.id, name: t.name, browser: b, status: "error", durationMs: 0,
        error: globalError || "La prueba no se ejecutó (revisa la sintaxis del código)", errorStack: null, userAgent: null, attachments: [], steps: [] });
    }
  }
  const order = new Map(tests.map((t, i) => [t.id, i]));
  return results.sort((a, b) => (order.get(a.testId) ?? 0) - (order.get(b.testId) ?? 0) || a.browser.localeCompare(b.browser));
}

export async function runUiTests(opts: UiRunOptions): Promise<{ results: UiTestResult[]; log: string }> {
  const workDir = resolve(RUNS_DIR, opts.runId);
  const outputDir = resolve(opts.artifactsRoot, opts.runId);
  const reportFile = resolve(workDir, "report.json");
  const stepsFile = resolve(workDir, "steps.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const syntaxErrors = new Map(opts.tests.map((t) => [t.id, checkSyntax(t)] as const).filter(([, e]) => e));
  const runnable = opts.tests.filter((t) => !syntaxErrors.has(t.id));
  const invalid: UiTestResult[] = opts.tests.filter((t) => syntaxErrors.has(t.id)).flatMap((t) =>
    opts.browsers.map((b) => ({ testId: t.id, name: t.name, browser: b, status: "error" as const, durationMs: 0,
      error: syntaxErrors.get(t.id)!, errorStack: null, userAgent: null, attachments: [], steps: [] })));
  if (runnable.length === 0) return { results: invalid, log: "" };

  await Promise.all(runnable.map((t, i) => writeFile(resolve(workDir, `t${String(i).padStart(3, "0")}.spec.ts`), buildSpec(t))));
  const configFile = resolve(workDir, "playwright.config.mjs");
  await writeFile(configFile, buildConfig({
    outputDir, reportFile, stepsReporter: resolve(here, "stepsReporter.mjs"), stepsFile,
    browsers: opts.browsers, baseURL: opts.baseURL || undefined,
    testTimeoutMs: opts.testTimeoutMs ?? 60_000, workers: opts.workers ?? 2, headless: opts.headless ?? true,
  }));

  const cli = resolve(dirname(require.resolve("@playwright/test/package.json")), "cli.js");
  const log = await new Promise<string>((resolveLog) => {
    let out = "";
    const child = spawn(process.execPath, [cli, "test", "--config", configFile], {
      cwd: workDir,
      env: { ...process.env, TF_VARS: JSON.stringify(opts.variables ?? {}), FORCE_COLOR: "0", CI: "1" },
    });
    const add = (d: Buffer) => { if (out.length < 200_000) out += d.toString(); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => { out += "\n[TestForge] Ejecución cancelada por tiempo máximo"; child.kill(); }, opts.runTimeoutMs ?? 15 * 60_000);
    child.on("close", () => { clearTimeout(timer); resolveLog(stripAnsi(out)); });
    child.on("error", (e) => { clearTimeout(timer); resolveLog(`No se pudo iniciar Playwright: ${e.message}`); });
  });

  let report: PwReport;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    const hint = /Executable doesn't exist|playwright install/i.test(log)
      ? "Faltan los navegadores de Playwright. Ejecuta: pnpm ui:browsers"
      : "Playwright no generó reporte";
    report = { errors: [{ message: `${hint}\n\n${log.slice(-3000)}` }] };
  }
  let stepsMap: Map<string, UiStep[]> | undefined;
  try {
    const raw = JSON.parse(await readFile(stepsFile, "utf8")) as Record<string, UiStep[]>;
    stepsMap = new Map(Object.entries(raw));
  } catch { stepsMap = undefined; }

  const order = new Map(opts.tests.map((t, i) => [t.id, i]));
  const results = [...parseReport(report, runnable, opts.browsers, opts.artifactsRoot, stepsMap), ...invalid]
    .sort((a, b) => (order.get(a.testId) ?? 0) - (order.get(b.testId) ?? 0) || a.browser.localeCompare(b.browser));
  if (/Executable doesn't exist/i.test(log)) {
    for (const r of results) if (r.status !== "passed") r.error = `Faltan los navegadores de Playwright. Ejecuta: pnpm ui:browsers\n\n${r.error ?? ""}`;
  }
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  return { results, log };
}

export { recordUiTest, extractBody } from "./recorder.js";
