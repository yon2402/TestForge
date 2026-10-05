import type { FastifyInstance } from "fastify";
import { sql } from "@testforge/db";
import { uiTestInput } from "@testforge/shared";
import { recordUiTest } from "@testforge/engine-ui";
import { z } from "zod";

type IdParams = { id: string };

export async function uiTestRoutes(app: FastifyInstance) {
  app.get<{ Params: IdParams }>("/api/projects/:id/ui-tests", async (req) =>
    sql`select * from ui_tests where project_id = ${req.params.id} order by sort_order, created_at`,
  );

  app.post<{ Params: IdParams }>("/api/projects/:id/ui-tests", async (req, reply) => {
    const d = uiTestInput.parse(req.body);
    const [{ next }] = await sql`select coalesce(max(sort_order) + 1, 0)::int as next from ui_tests where project_id = ${req.params.id}`;
    const [row] = await sql`insert into ui_tests (project_id, name, code, sort_order)
      values (${req.params.id}, ${d.name}, ${d.code}, ${next}) returning *`;
    return reply.status(201).send(row);
  });

  app.put<{ Params: IdParams }>("/api/ui-tests/:id", async (req, reply) => {
    const d = uiTestInput.parse(req.body);
    const [row] = await sql`update ui_tests set name = ${d.name}, code = ${d.code}, sort_order = ${d.sortOrder}
                            where id = ${req.params.id} returning *`;
    return row ?? reply.status(404).send({ error: "Prueba no encontrada" });
  });

  app.delete<{ Params: IdParams }>("/api/ui-tests/:id", async (req, reply) => {
    await sql`delete from ui_tests where id = ${req.params.id}`;
    return reply.status(204).send();
  });

  // Grabador: abre el navegador en la máquina donde corre la API. La persona hace clics,
  // y al cerrar la ventana se crea una prueba UI con el código grabado.
  const recordBody = z.object({ url: z.string().optional(), browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"), name: z.string().optional() });
  app.post<{ Params: IdParams }>("/api/projects/:id/record", async (req, reply) => {
    const [project] = await sql`select ui_base_url, base_url from projects where id = ${req.params.id}`;
    if (!project) return reply.status(404).send({ error: "Proyecto no encontrado" });
    const b = recordBody.parse(req.body ?? {});
    const url = b.url || (project.uiBaseUrl as string) || (project.baseUrl as string) || undefined;
    let code = "";
    try {
      ({ code } = await recordUiTest({ url, browser: b.browser }));
    } catch (e) {
      const msg = /Executable doesn|install/i.test((e as Error).message)
        ? "Faltan los navegadores de Playwright. Ejecuta: pnpm ui:browsers"
        : `No se pudo abrir el grabador: ${(e as Error).message}. El grabador solo funciona donde la API tiene pantalla (tu PC).`;
      return reply.status(400).send({ error: msg });
    }
    if (!code.trim()) return reply.status(400).send({ error: "No se grabó ninguna acción (cerraste la ventana sin interactuar)." });
    const [{ next }] = await sql`select coalesce(max(sort_order) + 1, 0)::int as next from ui_tests where project_id = ${req.params.id}`;
    const [row] = await sql`insert into ui_tests (project_id, name, code, sort_order)
      values (${req.params.id}, ${b.name || "Prueba grabada"}, ${code}, ${next}) returning *`;
    return reply.status(201).send(row);
  });
}
