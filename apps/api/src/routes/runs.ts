import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { env, sql } from "@testforge/db";
import { z } from "zod";
import { runInput, type RunJob } from "@testforge/shared";

type IdParams = { id: string };

export async function runRoutes(app: FastifyInstance, opts: { queue: Pick<Queue<RunJob>, "add"> }) {
  // Lanza una ejecución: se guarda como "queued" y la toma un worker
  app.post<{ Params: IdParams }>("/api/projects/:id/runs", async (req, reply) => {
    const data = runInput.parse(req.body ?? {});
    const [project] = await sql`select id from projects where id = ${req.params.id}`;
    if (!project) return reply.status(404).send({ error: "Proyecto no encontrado" });
    if (data.kind === "api") {
      const [{ count }] = await sql`select count(*)::int as count from api_requests where project_id = ${req.params.id}`;
      if (count === 0) return reply.status(400).send({ error: "El proyecto no tiene requests para ejecutar" });
    } else if (data.kind === "load") {
      if (!data.load) return reply.status(400).send({ error: "Falta la configuración de la prueba de carga" });
      const ids = data.load.requestIds;
      const [{ count }] = ids?.length
        ? await sql`select count(*)::int as count from api_requests where project_id = ${req.params.id} and id in ${sql(ids)}`
        : await sql`select count(*)::int as count from api_requests where project_id = ${req.params.id}`;
      if (count === 0) return reply.status(400).send({ error: "El proyecto no tiene requests para la prueba de carga" });
    } else if (data.kind === "security") {
      if (!data.security) return reply.status(400).send({ error: "Falta la configuración del escaneo" });
      if (data.security.mode === "active" && !data.security.authorizedActive)
        return reply.status(400).send({ error: "El escaneo activo requiere confirmar la autorización" });
    } else {
      const [{ count }] = data.testIds?.length
        ? await sql`select count(*)::int as count from ui_tests where project_id = ${req.params.id} and id in ${sql(data.testIds)}`
        : await sql`select count(*)::int as count from ui_tests where project_id = ${req.params.id}`;
      if (count === 0) return reply.status(400).send({ error: "El proyecto no tiene pruebas UI para ejecutar" });
    }

    const options =
      data.kind === "ui" ? { browsers: data.browsers, testIds: data.testIds ?? null } :
      data.kind === "load" ? { load: data.load } :
      data.kind === "security" ? { security: data.security } : {};
    const [run] = await sql`insert into runs (project_id, environment_id, trigger, kind, options)
      values (${req.params.id}, ${data.environmentId ?? null}, ${data.trigger}, ${data.kind}, ${sql.json(options)}) returning *`;
    await opts.queue.add(`${data.kind}-run`, { runId: run.id as string }, { removeOnComplete: 1000, removeOnFail: 1000 });
    return reply.status(202).send(run);
  });

  // Borra varias ejecuciones (con sus resultados, capturas, videos y trazas).
  // Las que siguen en cola o ejecutándose no se borran.
  const deleteBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
  app.post("/api/runs/delete", async (req) => {
    const { ids } = deleteBody.parse(req.body);
    const deleted = await sql`delete from runs where id in ${sql(ids)} and status not in ('queued', 'running') returning id`;
    const root = resolve(env.artifactsDir);
    for (const { id } of deleted) {
      const dir = resolve(root, id as string);
      if (dir.startsWith(root + sep)) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return { deleted: deleted.map((r) => r.id), skipped: ids.length - deleted.length };
  });

  // Pide a una ejecución de carga en curso que se detenga
  app.post<{ Params: IdParams }>("/api/runs/:id/stop", async (req, reply) => {
    const [run] = await sql`update runs set stop_requested = true where id = ${req.params.id} returning id, status`;
    if (!run) return reply.status(404).send({ error: "Ejecución no encontrada" });
    return { ok: true };
  });

  // Progreso en vivo de un escaneo de seguridad
  app.get<{ Params: IdParams }>("/api/runs/:id/progress", async (req) => {
    const [r] = await sql`select progress, status from runs where id = ${req.params.id}`;
    return { progress: r?.progress ?? null, status: r?.status ?? null };
  });

  // Muestras en vivo de una ejecución de carga (para las gráficas)
  app.get<{ Params: IdParams }>("/api/runs/:id/samples", async (req) => {
    const rows = await sql`select data from load_samples where run_id = ${req.params.id} order by t`;
    return rows.map((r) => r.data);
  });

  app.get<{ Params: IdParams }>("/api/projects/:id/runs", async (req) =>
    sql`select r.*, e.name as environment_name from runs r
        left join environments e on e.id = r.environment_id
        where r.project_id = ${req.params.id} order by r.created_at desc limit 50`,
  );

  app.get<{ Params: IdParams }>("/api/runs/:id", async (req, reply) => {
    const [run] = await sql`select r.*, e.name as environment_name, p.name as project_name from runs r
        join projects p on p.id = r.project_id
        left join environments e on e.id = r.environment_id
        where r.id = ${req.params.id}`;
    if (!run) return reply.status(404).send({ error: "Ejecución no encontrada" });
    const results = await sql`select * from run_results where run_id = ${req.params.id} order by position`;
    return { ...run, results };
  });

  // Reporte JUnit XML para CI (Jenkins, GitLab, GitHub Actions)
  app.get<{ Params: IdParams }>("/api/runs/:id/junit.xml", async (req, reply) => {
    const [run] = await sql`select r.*, p.name as project_name from runs r join projects p on p.id = r.project_id
                            where r.id = ${req.params.id}`;
    if (!run) return reply.status(404).send({ error: "Ejecución no encontrada" });
    const results = await sql`select * from run_results where run_id = ${req.params.id} order by position`;
    const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const loadThs = run.kind === "load"
      ? ((run.summary as { load?: { thresholds?: { name: string; limit: string; actual: string; passed: boolean }[] } })?.load?.thresholds ?? [])
      : [];
    const secCount = run.kind === "security" ? ((run.summary as { security?: { findings?: unknown[] } })?.security?.findings?.length ?? 0) : 0;
    const secHigh = run.kind === "security" ? ((run.summary as { security?: { counts?: { high?: number } } })?.security?.counts?.high ?? 0) : 0;
    const failures = results.filter((r) => r.status === "failed").length + loadThs.filter((t) => !t.passed).length + secHigh;
    const errors = results.filter((r) => r.status === "error").length;
    const totalTests = results.length + loadThs.length + secCount;
    const cases = results.map((r) => {
      const time = ((r.durationMs as number) / 1000).toFixed(3);
      const failed = (r.assertions as { passed: boolean; message: string }[]).filter((a) => !a.passed);
      let inner = "";
      if (r.status === "failed") inner = `<failure message="${esc(r.kind === "ui" ? ((r.error as string) ?? "falló") : failed.map((a) => a.message).join("; "))}"/>`;
      if (r.status === "skipped") inner = "<skipped/>";
      if (r.status === "error") inner = `<error message="${esc((r.error as string) ?? "error")}"/>`;
      const classname = r.kind === "ui" ? `ui.${r.browser}` : "api";
      return `    <testcase classname="${classname}" name="${esc(r.name as string)}" time="${time}">${inner}</testcase>`;
    });
    for (const t of loadThs) {
      const inner = t.passed ? "" : `<failure message="${esc(`${t.name}: esperado ${t.limit}, obtenido ${t.actual}`)}"/>`;
      cases.push(`    <testcase classname="carga" name="${esc(t.name)}">${inner}</testcase>`);
    }
    const secReport = run.kind === "security" ? (run.summary as { security?: { findings?: { name: string; severity: string; cwe: string | null; url: string }[] } })?.security : null;
    const secFindings = secReport?.findings ?? [];
    for (const f of secFindings) {
      // Los hallazgos de severidad alta hacen fallar el caso (y el pipeline)
      const high = f.severity === "high";
      const inner = high ? `<failure message="${esc(`${f.severity.toUpperCase()} ${f.cwe ?? ""} en ${f.url}`)}"/>` : "";
      cases.push(`    <testcase classname="seguridad.${esc(f.severity)}" name="${esc(f.name)}">${inner}</testcase>`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${esc(run.projectName as string)}" tests="${totalTests}" failures="${failures}" errors="${errors}">
${cases.join("\n")}
  </testsuite>
</testsuites>
`;
    return reply.type("application/xml").send(xml);
  });
}
