import { env, sql } from "@testforge/db";
import { interpolate, runCollection, summarize } from "@testforge/engine-api";
import { runUiTests, type Browser } from "@testforge/engine-ui";
import { runLoadTest } from "@testforge/engine-load";
import { httpZapClient, runSecurityScan } from "@testforge/engine-security";
import type { ApiRequestInput, LoadConfig, LoadSample, RunStatus, RunSummary, SecurityConfig } from "@testforge/shared";

// Ejecuta todos los requests del proyecto en orden y guarda cada resultado al terminar
export async function processRun(runId: string): Promise<RunStatus> {
  const [run] = await sql`update runs set status = 'running', started_at = now() where id = ${runId} returning *`;
  if (!run) throw new Error(`Ejecución ${runId} no existe`);
  try {
    const [project] = await sql`select * from projects where id = ${run.projectId}`;
    let variables: Record<string, string> = {};
    if (run.environmentId) {
      const [envRow] = await sql`select variables from environments where id = ${run.environmentId}`;
      variables = (envRow?.variables as Record<string, string>) ?? {};
    }
    if (run.kind === "ui") {
      const summary = await processUiRun(runId, run, project, variables);
      const status: RunStatus = summary.failed + summary.errors === 0 ? "passed" : "failed";
      await sql`update runs set status = ${status}, summary = ${sql.json(summary)}, finished_at = now() where id = ${runId}`;
      return status;
    }
    if (run.kind === "security") {
      const summary = await processSecurityRun(runId, run);
      // Un escaneo "falla" si encuentra hallazgos de severidad alta
      const high = summary.security?.counts.high ?? 0;
      const status: RunStatus = high > 0 ? "failed" : "passed";
      await sql`update runs set status = ${status}, summary = ${sql.json(summary as never)}, finished_at = now() where id = ${runId}`;
      return status;
    }
    if (run.kind === "load") {
      const summary = await processLoadRun(runId, run, project, variables);
      // Una prueba de carga "pasa" si no hay umbrales definidos o si todos se cumplen
      const ths = summary.load?.thresholds ?? [];
      const status: RunStatus = ths.every((t) => t.passed) ? "passed" : "failed";
      await sql`update runs set status = ${status}, summary = ${sql.json(summary)}, finished_at = now() where id = ${runId}`;
      return status;
    }

    const requests = (await sql`select * from api_requests where project_id = ${run.projectId}
                                order by sort_order, created_at`) as unknown as (ApiRequestInput & { id: string })[];

    const { summary } = await runCollection(requests, {
      variables,
      baseUrl: project.baseUrl as string,
      onResult: async (r, position) => {
        await sql`insert into run_results
          (run_id, request_id, position, name, status, duration_ms, request, response, assertions, captured, error)
          values (${runId}, ${r.requestId ?? null}, ${position}, ${r.name}, ${r.status}, ${r.durationMs},
                  ${sql.json(r.request as never)}, ${r.response ? sql.json(r.response as never) : null},
                  ${sql.json(r.assertions as never)}, ${sql.json(r.captured)}, ${r.error})`;
      },
    });

    const status: RunStatus = summary.failed + summary.errors === 0 ? "passed" : "failed";
    await sql`update runs set status = ${status}, summary = ${sql.json(summary)}, finished_at = now() where id = ${runId}`;
    return status;
  } catch (e) {
    await sql`update runs set status = 'error', error = ${(e as Error).message}, finished_at = now() where id = ${runId}`;
    throw e;
  }
}

type Row = Record<string, unknown>;

async function processUiRun(runId: string, run: Row, project: Row, variables: Record<string, string>): Promise<RunSummary> {
  const options = (run.options ?? {}) as { browsers?: Browser[]; testIds?: string[] | null };
  const all = await sql`select id, name, code from ui_tests where project_id = ${run.projectId as string} order by sort_order, created_at`;
  const tests = all
    .filter((t) => !options.testIds?.length || options.testIds.includes(t.id as string))
    .map((t) => ({ id: t.id as string, name: t.name as string, code: t.code as string }));
  const baseURL = interpolate(((project.uiBaseUrl as string) || (project.baseUrl as string) || ""), variables);

  const started = Date.now();
  const { results, log } = await runUiTests({
    runId,
    tests,
    browsers: options.browsers?.length ? options.browsers : ["chromium"],
    baseURL: baseURL || undefined,
    variables,
    artifactsRoot: env.artifactsDir,
  });
  if (results.length === 0) throw new Error(`Playwright no devolvió resultados.\n${log.slice(-2000)}`);

  // Copia del código en el momento de ejecutar, para verlo en el reporte aunque luego se edite o borre la prueba
  const codeById = new Map(tests.map((t) => [t.id, t.code]));

  for (const [position, r] of results.entries()) {
    await sql`insert into run_results
      (run_id, request_id, position, name, status, duration_ms, kind, browser, attachments, steps, error, user_agent, code)
      values (${runId}, ${r.testId || null}, ${position}, ${r.name}, ${r.status}, ${r.durationMs}, 'ui', ${r.browser},
              ${sql.json(r.attachments)}, ${sql.json(r.steps as never)}, ${r.error}, ${r.userAgent ?? null}, ${codeById.get(r.testId) ?? null})`;
  }
  // summarize espera la forma de los resultados de API; solo usa status
  return summarize(results.map((r) => ({ status: r.status })) as never, Date.now() - started);
}

async function processLoadRun(runId: string, run: Row, project: Row, variables: Record<string, string>): Promise<RunSummary> {
  const options = (run.options ?? {}) as { load?: LoadConfig };
  const cfg = options.load;
  if (!cfg) throw new Error("La ejecución de carga no tiene configuración");
  const ids = cfg.requestIds;
  const all = await sql`select * from api_requests where project_id = ${run.projectId as string} order by sort_order, created_at`;
  const requests = (all as unknown as (ApiRequestInput & { id: string })[])
    .filter((r) => !ids?.length || ids.includes(r.id));
  const baseUrl = (project.baseUrl as string) || "";

  const started = Date.now();
  let lastStopCheck = 0;
  let stop = false;

  const { report } = await runLoadTest({
    requests, config: cfg, variables, baseUrl,
    onSample: async (s: LoadSample) => {
      await sql`insert into load_samples (run_id, t, data) values (${runId}, ${s.t}, ${sql.json(s)})`;
    },
    // Cada ~2 s revisa si el usuario pulsó Detener
    shouldStop: async () => {
      const now = Date.now();
      if (now - lastStopCheck < 2000) return stop;
      lastStopCheck = now;
      const [r] = await sql`select stop_requested from runs where id = ${runId}`;
      stop = Boolean(r?.stopRequested);
      return stop;
    },
  });

  const failed = report.thresholds.filter((t) => !t.passed).length;
  return {
    total: report.thresholds.length,
    passed: report.thresholds.filter((t) => t.passed).length,
    failed, errors: 0, durationMs: Date.now() - started,
    load: report,
  };
}

async function processSecurityRun(runId: string, run: Row): Promise<RunSummary> {
  const options = (run.options ?? {}) as { security?: SecurityConfig };
  const cfg = options.security;
  if (!cfg) throw new Error("El escaneo no tiene configuración");
  const client = httpZapClient(env.zapUrl);
  let lastStopCheck = 0, stop = false;
  const started = Date.now();
  const report = await runSecurityScan({
    config: cfg, client,
    onProgress: async (p) => { await sql`update runs set progress = ${sql.json(p)} where id = ${runId}`; },
    shouldStop: async () => {
      const now = Date.now();
      if (now - lastStopCheck < 2000) return stop;
      lastStopCheck = now;
      const [r] = await sql`select stop_requested from runs where id = ${runId}`;
      stop = Boolean(r?.stopRequested);
      return stop;
    },
  });
  const failed = report.counts.high;
  return { total: report.findings.length, passed: 0, failed, errors: 0, durationMs: Date.now() - started, security: report };
}
