import Fastify from "fastify";
import cors from "@fastify/cors";
import { Queue } from "bullmq";
import { ZodError } from "zod";
import { sql } from "@testforge/db";
import type { RunJob } from "@testforge/shared";
import { projectRoutes } from "./routes/projects.js";
import { requestRoutes } from "./routes/requests.js";
import { runRoutes } from "./routes/runs.js";
import { uiTestRoutes } from "./routes/uiTests.js";
import { artifactRoutes } from "./routes/artifacts.js";

export async function buildServer(queue: Pick<Queue<RunJob>, "add">) {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Datos inválidos", issues: err.issues });
    }
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (e.code === "22P02") return reply.status(400).send({ error: "Identificador inválido" });
    app.log.error(err);
    return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Error interno" });
  });

  app.get("/api/health", async () => {
    await sql`select 1`;
    return { ok: true };
  });

  await app.register(projectRoutes);
  await app.register(requestRoutes);
  await app.register(uiTestRoutes);
  await app.register(artifactRoutes);
  await app.register(runRoutes, { queue });
  return app;
}
