import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUiTests } from "../src/index";

let server: Server;
let base = "";
const root = mkdtempSync(join(tmpdir(), "tf-ui-"));

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Tienda Demo</title><h1>Hola</h1>
      <form onsubmit="event.preventDefault(); document.querySelector('#msg').textContent = 'Bienvenido ' + this.u.value">
        <label>Usuario <input name="u"></label><button>Entrar</button></form><p id="msg"></p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("motor UI", () => {
  it("ejecuta pruebas, reporta fallos y guarda capturas", async () => {
    const { results, log } = await runUiTests({
      runId: "test-run",
      artifactsRoot: root,
      browsers: ["chromium"],
      baseURL: base,
      variables: { user: "Ana" },
      tests: [
        { id: "a", name: "login", code: `await page.goto("/");\nawait page.getByLabel("Usuario").fill(vars.user);\nawait page.getByRole("button", { name: "Entrar" }).click();\nawait expect(page.locator("#msg")).toHaveText("Bienvenido Ana");` },
        { id: "b", name: "titulo incorrecto", code: `await page.goto("/");\nawait expect(page).toHaveTitle("Otra cosa", { timeout: 1000 });` },
      ],
    });
    if (results.some((r) => r.status === "error")) console.log(log);
    expect(results.map((r) => [r.testId, r.status])).toEqual([["a", "passed"], ["b", "failed"]]);
    expect(results[1].error).toContain("toHaveTitle");
    const shot = results[0].attachments.find((a) => a.contentType === "image/png");
    expect(shot).toBeTruthy();
    expect(existsSync(join(root, shot!.path))).toBe(true);
    expect(results[1].attachments.some((a) => a.name === "trace")).toBe(true);
    expect(results[1].attachments.some((a) => a.name === "video")).toBe(true);
  }, 120_000);

  it("marca como error una prueba con sintaxis inválida", async () => {
    const { results } = await runUiTests({
      runId: "test-syntax", artifactsRoot: root, browsers: ["chromium"], baseURL: base,
      tests: [{ id: "x", name: "rota", code: "await page.goto('/'" }],
    });
    expect(results[0].status).toBe("error");
    expect(results[0].error).toBeTruthy();
  }, 120_000);
});

describe("sintaxis", () => {
  it("ubica la línea del error en el código del tester y deja correr las demás", async () => {
    const { results } = await runUiTests({
      runId: "test-mixed", artifactsRoot: root, browsers: ["chromium"],
      tests: [
        { id: "ok", name: "ok", code: "await page.setContent('<h1>x</h1>');\nawait expect(page.locator('h1')).toHaveText('x');" },
        { id: "bad", name: "bad", code: "await page.setContent('<p>a</p>');\nawait page.click('p'\nconst x = 1;" },
      ],
    });
    expect(results.map((r) => [r.testId, r.status])).toEqual([["ok", "passed"], ["bad", "error"]]);
    expect(results[1].error).toMatch(/línea 3/);
  }, 120_000);
});
