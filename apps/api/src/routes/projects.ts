import type { FastifyInstance } from "fastify";
import { sql } from "@testforge/db";
import { environmentInput, projectInput } from "@testforge/shared";

type IdParams = { id: string };

export async function projectRoutes(app: FastifyInstance) {
  // ---------- Proyectos ----------
  app.get("/api/projects", async () =>
    sql`select p.*, (select count(*)::int from api_requests r where r.project_id = p.id) as request_count,
               (select count(*)::int from ui_tests u where u.project_id = p.id) as ui_test_count
        from projects p order by p.created_at desc`,
  );

  app.post("/api/projects", async (req, reply) => {
    const data = projectInput.parse(req.body);
    const [project] = await sql`insert into projects (name, base_url, ui_base_url)
      values (${data.name}, ${data.baseUrl}, ${data.uiBaseUrl}) returning *`;
    return reply.status(201).send(project);
  });

  app.get<{ Params: IdParams }>("/api/projects/:id", async (req, reply) => {
    const [project] = await sql`select * from projects where id = ${req.params.id}`;
    return project ?? reply.status(404).send({ error: "Proyecto no encontrado" });
  });

  app.put<{ Params: IdParams }>("/api/projects/:id", async (req, reply) => {
    const data = projectInput.parse(req.body);
    const [project] = await sql`update projects set name = ${data.name}, base_url = ${data.baseUrl}, ui_base_url = ${data.uiBaseUrl}
                                where id = ${req.params.id} returning *`;
    return project ?? reply.status(404).send({ error: "Proyecto no encontrado" });
  });

  app.delete<{ Params: IdParams }>("/api/projects/:id", async (req, reply) => {
    await sql`delete from projects where id = ${req.params.id}`;
    return reply.status(204).send();
  });

  // ---------- Entornos ----------
  app.get<{ Params: IdParams }>("/api/projects/:id/environments", async (req) =>
    sql`select * from environments where project_id = ${req.params.id} order by created_at`,
  );

  app.post<{ Params: IdParams }>("/api/projects/:id/environments", async (req, reply) => {
    const data = environmentInput.parse(req.body);
    const [envRow] = await sql`insert into environments (project_id, name, variables)
      values (${req.params.id}, ${data.name}, ${sql.json(data.variables)}) returning *`;
    return reply.status(201).send(envRow);
  });

  app.put<{ Params: IdParams }>("/api/environments/:id", async (req, reply) => {
    const data = environmentInput.parse(req.body);
    const [envRow] = await sql`update environments set name = ${data.name}, variables = ${sql.json(data.variables)}
                               where id = ${req.params.id} returning *`;
    return envRow ?? reply.status(404).send({ error: "Entorno no encontrado" });
  });

  app.delete<{ Params: IdParams }>("/api/environments/:id", async (req, reply) => {
    await sql`delete from environments where id = ${req.params.id}`;
    return reply.status(204).send();
  });
}
