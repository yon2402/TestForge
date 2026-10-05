import type { FastifyInstance } from "fastify";
import { sql } from "@testforge/db";
import { apiRequestInput, parseImport } from "@testforge/shared";
import { executeRequest } from "@testforge/engine-api";
import { z } from "zod";

type IdParams = { id: string };

export async function requestRoutes(app: FastifyInstance) {
  app.get<{ Params: IdParams }>("/api/projects/:id/requests", async (req) =>
    sql`select * from api_requests where project_id = ${req.params.id} order by sort_order, created_at`,
  );

  app.post<{ Params: IdParams }>("/api/projects/:id/requests", async (req, reply) => {
    const d = apiRequestInput.parse(req.body);
    const [{ next }] = await sql`select coalesce(max(sort_order) + 1, 0)::int as next from api_requests where project_id = ${req.params.id}`;
    const [row] = await sql`insert into api_requests
      (project_id, name, method, url, headers, body, assertions, captures, sort_order)
      values (${req.params.id}, ${d.name}, ${d.method}, ${d.url}, ${sql.json(d.headers)}, ${d.body},
              ${sql.json(d.assertions as never)}, ${sql.json(d.captures)}, ${next})
      returning *`;
    return reply.status(201).send(row);
  });

  app.put<{ Params: IdParams }>("/api/requests/:id", async (req, reply) => {
    const d = apiRequestInput.parse(req.body);
    const [row] = await sql`update api_requests set
        name = ${d.name}, method = ${d.method}, url = ${d.url}, headers = ${sql.json(d.headers)},
        body = ${d.body}, assertions = ${sql.json(d.assertions as never)}, captures = ${sql.json(d.captures)},
        sort_order = ${d.sortOrder}
      where id = ${req.params.id} returning *`;
    return row ?? reply.status(404).send({ error: "Request no encontrado" });
  });

  app.delete<{ Params: IdParams }>("/api/requests/:id", async (req, reply) => {
    await sql`delete from api_requests where id = ${req.params.id}`;
    return reply.status(204).send();
  });

  // "Enviar" al estilo Postman: ejecuta un solo request al momento, sin pasar por la cola
  const sendBody = z.object({
    request: apiRequestInput,
    environmentId: z.string().uuid().nullable().optional(),
    // Variables capturadas en envíos anteriores de esta sesión (tienen prioridad sobre el entorno)
    sessionVariables: z.record(z.string()).default({}),
  });
  // Importa una colección Postman v2.1 o un OpenAPI 3; crea los requests en el proyecto
  app.post<{ Params: IdParams }>("/api/projects/:id/import", async (req, reply) => {
    const [project] = await sql`select id from projects where id = ${req.params.id}`;
    if (!project) return reply.status(404).send({ error: "Proyecto no encontrado" });
    let result;
    try { result = parseImport((req.body as { collection?: unknown })?.collection ?? req.body); }
    catch (e) { return reply.status(400).send({ error: (e as Error).message }); }
    if (result.requests.length === 0) return reply.status(400).send({ error: "No se encontraron requests para importar" });
    const [{ next }] = await sql`select coalesce(max(sort_order) + 1, 0)::int as next from api_requests where project_id = ${req.params.id}`;
    let i = 0;
    for (const r of result.requests) {
      await sql`insert into api_requests (project_id, name, method, url, headers, body, assertions, captures, sort_order)
        values (${req.params.id}, ${r.name}, ${r.method}, ${r.url}, ${sql.json(r.headers)}, ${r.body},
                ${sql.json(r.assertions as never)}, ${sql.json(r.captures)}, ${(next as number) + i++})`;
    }
    return reply.status(201).send({ imported: result.requests.length, format: result.format,
      name: result.name, variables: result.variables, warnings: result.warnings });
  });

  app.post<{ Params: IdParams }>("/api/projects/:id/send", async (req, reply) => {
    const { request, environmentId, sessionVariables } = sendBody.parse(req.body);
    const [project] = await sql`select * from projects where id = ${req.params.id}`;
    if (!project) return reply.status(404).send({ error: "Proyecto no encontrado" });
    let variables: Record<string, string> = {};
    if (environmentId) {
      const [envRow] = await sql`select variables from environments where id = ${environmentId}`;
      variables = (envRow?.variables as Record<string, string>) ?? {};
    }
    return executeRequest(request, { variables: { ...variables, ...sessionVariables }, baseUrl: project.baseUrl as string });
  });
}
