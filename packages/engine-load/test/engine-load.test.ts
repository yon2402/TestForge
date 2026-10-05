import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildStages, percentile, runLoadTest, targetAt, totalDuration } from "../src/index";

let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: 1 })); }
    else if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("ok"); }, 30); }
    else if (req.url === "/err") { res.writeHead(500); res.end("boom"); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("etapas y percentiles", () => {
  it("construye etapas de carga con subida, meseta y bajada", () => {
    const s = buildStages({ mode: "load", vus: 20, rampUpSec: 5, durationSec: 10 });
    expect(s).toEqual([{ durationSec: 5, target: 20 }, { durationSec: 10, target: 20 }, { durationSec: 3, target: 0 }]);
    expect(totalDuration(s)).toBe(18);
    expect(targetAt(s, 0)).toBe(0);
    expect(targetAt(s, 2.5)).toBe(10); // mitad de la subida
    expect(targetAt(s, 8)).toBe(20);   // en meseta
  });
  it("estrés sube por escalones hasta el máximo", () => {
    const s = buildStages({ mode: "stress", vus: 50, rampUpSec: 5, durationSec: 50 });
    expect(Math.max(...s.map((x) => x.target))).toBe(50);
    expect(s.at(-1)).toEqual({ durationSec: expect.any(Number), target: 0 });
  });
  it("percentiles", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
  });
});

describe("ejecución de carga", () => {
  it("genera tráfico, mide y evalúa umbrales", async () => {
    hits = 0;
    const { samples, report } = await runLoadTest({
      baseUrl: base,
      requests: [{ name: "ok", method: "GET", url: "/ok", headers: {}, body: null, sortOrder: 0,
        assertions: [{ type: "status", equals: 200 }], captures: [] }],
      config: { mode: "load", vus: 5, rampUpSec: 1, durationSec: 2, thinkTimeMs: 0, maxRps: null,
        validateAssertions: true, requestIds: null, thresholds: { p95Ms: 5000, errorRatePct: 1, minRps: null } },
    });
    expect(report.totalRequests).toBeGreaterThan(10);
    expect(report.totalRequests).toBe(hits);
    expect(report.errorRatePct).toBe(0);
    expect(report.maxVus).toBe(5);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(report.perRequest[0].name).toBe("ok");
    expect(report.thresholds.every((t) => t.passed)).toBe(true);
  }, 30_000);

  it("respeta el límite de peticiones por segundo", async () => {
    const { report } = await runLoadTest({
      baseUrl: base,
      requests: [{ name: "ok", method: "GET", url: "/ok", headers: {}, body: null, sortOrder: 0, assertions: [], captures: [] }],
      config: { mode: "load", vus: 20, rampUpSec: 0, durationSec: 3, thinkTimeMs: 0, maxRps: 25,
        validateAssertions: false, requestIds: null, thresholds: { p95Ms: null, errorRatePct: null, minRps: null } },
    });
    // 25 rps durante ~3 s de meseta: debe quedar muy por debajo de lo que 20 usuarios harían sin límite
    expect(report.avgRps).toBeLessThanOrEqual(40);
    expect(report.peakRps).toBeLessThanOrEqual(45);
  }, 30_000);

  it("cuenta errores HTTP y marca umbral fallido", async () => {
    const { report } = await runLoadTest({
      baseUrl: base,
      requests: [{ name: "err", method: "GET", url: "/err", headers: {}, body: null, sortOrder: 0, assertions: [], captures: [] }],
      config: { mode: "load", vus: 3, rampUpSec: 0, durationSec: 1, thinkTimeMs: 0, maxRps: null,
        validateAssertions: false, requestIds: null, thresholds: { p95Ms: null, errorRatePct: 10, minRps: null } },
    });
    expect(report.errorRatePct).toBe(100);
    expect(report.statusCodes["500"]).toBeGreaterThan(0);
    expect(report.thresholds[0].passed).toBe(false);
  }, 30_000);

  it("se detiene antes cuando se lo piden", async () => {
    const t0 = Date.now();
    await runLoadTest({
      baseUrl: base,
      requests: [{ name: "ok", method: "GET", url: "/ok", headers: {}, body: null, sortOrder: 0, assertions: [], captures: [] }],
      config: { mode: "load", vus: 3, rampUpSec: 0, durationSec: 60, thinkTimeMs: 0, maxRps: null,
        validateAssertions: false, requestIds: null, thresholds: { p95Ms: null, errorRatePct: null, minRps: null } },
      shouldStop: () => Date.now() - t0 > 1500,
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});
