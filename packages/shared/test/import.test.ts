import { describe, expect, it } from "vitest";
import { parseImport, detectFormat } from "../src/import";

describe("importar Postman", () => {
  const col = {
    info: { name: "Mi API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "host", value: "https://api.example.com" }],
    item: [
      { name: "Carpeta", item: [
        { name: "Login", request: {
          method: "POST", url: { raw: "{{host}}/login" },
          header: [{ key: "Content-Type", value: "application/json" }],
          body: { mode: "raw", raw: '{"u":"a"}' } },
          event: [{ listen: "test", script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));", "pm.expect(pm.response.responseTime).to.be.below(500);"] } }] },
      ] },
      { name: "Lista", request: { method: "GET", url: { host: ["{{host}}"], path: ["items"], query: [{ key: "page", value: "1" }] } } },
    ],
  };
  it("detecta y convierte", () => {
    expect(detectFormat(col)).toBe("postman");
    const r = parseImport(col);
    expect(r.name).toBe("Mi API");
    expect(r.variables.host).toBe("https://api.example.com");
    expect(r.requests.map((x) => x.name)).toEqual(["Login", "Lista"]);
    expect(r.requests[0]).toMatchObject({ method: "POST", url: "{{host}}/login" });
    expect(r.requests[0].assertions).toEqual([{ type: "status", equals: 200 }, { type: "responseTime", lessThanMs: 500 }]);
    expect(r.requests[1].url).toBe("{{host}}/items?page=1");
  });
});

describe("importar OpenAPI", () => {
  const doc = {
    openapi: "3.0.0",
    info: { title: "Tienda" },
    servers: [{ url: "https://api.tienda.com" }],
    paths: {
      "/users/{id}": { get: { summary: "Ver usuario", parameters: [{ name: "id", in: "path", required: true, example: 7 }],
        responses: { "200": {} } } },
      "/users": { post: { summary: "Crear usuario",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { nombre: { type: "string" }, edad: { type: "integer" } } } } } },
        responses: { "201": {} } } },
    },
  };
  it("detecta y convierte", () => {
    expect(detectFormat(doc)).toBe("openapi");
    const r = parseImport(doc);
    expect(r.name).toBe("Tienda");
    expect(r.variables.host).toBe("https://api.tienda.com");
    const get = r.requests.find((x) => x.name === "Ver usuario")!;
    expect(get.url).toBe("{{host}}/users/{{id}}");
    expect(get.assertions).toEqual([{ type: "status", equals: 200 }]);
    const post = r.requests.find((x) => x.name === "Crear usuario")!;
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body!)).toEqual({ nombre: "texto", edad: 0 });
    expect(post.assertions).toEqual([{ type: "status", equals: 201 }]);
  });
});

it("rechaza formato desconocido", () => {
  expect(() => parseImport({ foo: 1 })).toThrow();
});
