import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { env } from "@testforge/db";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webm": "video/webm",
  ".zip": "application/zip", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

// Sirve capturas, videos y trazas guardadas por el worker
export async function artifactRoutes(app: FastifyInstance) {
  app.get<{ Params: { "*": string } }>("/api/artifacts/*", async (req, reply) => {
    const root = resolve(env.artifactsDir);
    const file = resolve(root, req.params["*"]);
    if (!file.startsWith(root + sep)) return reply.status(400).send({ error: "Ruta inválida" });
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return reply.status(404).send({ error: "Archivo no encontrado" });
    reply.header("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    reply.header("Content-Length", info.size);
    reply.header("Access-Control-Allow-Origin", "*"); // para abrir trazas en trace.playwright.dev
    return reply.send(createReadStream(file));
  });
}
