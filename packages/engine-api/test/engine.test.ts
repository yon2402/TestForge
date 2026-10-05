import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { evaluateAssertion, executeRequest, getJsonPath, interpolate, runCollection } from "../src/index";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/login" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "abc" });
      res.end(JSON.stringify({ token: "t-123" }));
    } else if (req.url === "/me") {
      const ok = req.headers.authorization === "Bearer t-123";
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { user: { id: 7, roles: ["qa", "admin"] } } : { error: "no auth" }));
    } else {
      res.writeHead(404); res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("utilidades", () => {
  it("interpola variables y deja las desconocidas", () => {
    expect(interpolate("{{host}}/a/{{ id }}/{{x}}", { host: "h", id: "1" })).toBe("h/a/1/{{x}}");
  });
  it("lee rutas JSON", () => {
    const o = { data: { items: [{ id: 5 }] } };
    expect(getJsonPath(o, "data.items[0].id").value).toBe(5);
    expect(getJsonPath(o, "$.data.items.length").value).toBe(1);
    expect(getJsonPath(o, "data.nope").found).toBe(false);
  });
  it("evalúa esquema JSON", () => {
    const resp = { status: 200, statusText: "OK", headers: {}, body: "{}", json: { id: "x" }, sizeBytes: 2, truncated: false };
    const r = evaluateAssertion({ type: "jsonSchema", schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } }, resp, 1);
    expect(r.passed).toBe(false);
    expect(r.message).toContain("/id");
  });
});

describe("ejecución", () => {
  it("encadena un token capturado entre requests", async () => {
    const { results, summary } = await runCollection([
      { name: "login", method: "POST", url: "/login", headers: {}, body: '{"u":"a"}', sortOrder: 0,
        assertions: [{ type: "status", equals: 200 }, { type: "header", name: "X-Request-Id", op: "equals", value: "abc" }],
        captures: [{ variable: "token", from: "jsonPath", path: "token" }] },
      { name: "me", method: "GET", url: "/me", headers: { Authorization: "Bearer {{token}}" }, body: null, sortOrder: 1,
        assertions: [
          { type: "status", equals: 200 },
          { type: "jsonPath", path: "user.id", op: "equals", value: "7" },
          { type: "jsonPath", path: "user.roles", op: "contains", value: "admin" },
          { type: "responseTime", lessThanMs: 2000 },
        ], captures: [] },
    ], { baseUrl: base });
    expect(results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
  });

  it("marca fallo con esperado vs obtenido", async () => {
    const r = await executeRequest({ name: "x", method: "GET", url: `${base}/nada`, headers: {}, body: null, sortOrder: 0,
      assertions: [{ type: "status", equals: 200 }], captures: [] });
    expect(r.status).toBe("failed");
    expect(r.assertions[0]).toMatchObject({ expected: 200, actual: 404 });
  });

  it("reporta variables faltantes y errores de conexión", async () => {
    const a = await executeRequest({ name: "x", method: "GET", url: "{{host}}/x", headers: {}, body: null, sortOrder: 0, assertions: [], captures: [] });
    expect(a.error).toContain("host");
    const b = await executeRequest({ name: "x", method: "GET", url: "http://127.0.0.1:1/x", headers: {}, body: null, sortOrder: 0, assertions: [], captures: [] });
    expect(b.status).toBe("error");
    expect(b.error).toContain("No se pudo conectar");
  });
});
