import { describe, expect, it, vi } from "vitest";
import { buildReport, inScope, runSecurityScan, type ZapClient } from "../src/index";
import type { SecurityConfig } from "@testforge/shared";

const cfg = (over: Partial<SecurityConfig> = {}): SecurityConfig => ({
  targetUrl: "http://localhost:3000", mode: "passive", scope: [], maxDurationMin: 10, authorizedActive: false, ...over,
});

const alerts = [
  { name: "Cross Site Scripting (Reflected)", risk: "High", confidence: "Medium", cweid: "79", url: "http://localhost:3000/s?q=x", param: "q", evidence: "<script>", description: "XSS", solution: "Escapar", reference: "owasp" },
  { name: "Cross Site Scripting (Reflected)", risk: "High", confidence: "Medium", cweid: "79", url: "http://localhost:3000/s?q=y", param: "q", evidence: "<script>", description: "XSS", solution: "Escapar", reference: "owasp" },
  { name: "Missing Anti-clickjacking Header", risk: "Medium", confidence: "High", cweid: "1021", url: "http://localhost:3000/", param: "", evidence: "", description: "falta header", solution: "añadir", reference: "" },
  { name: "Info Disclosure", risk: "Informational", confidence: "Low", cweid: "-1", url: "http://localhost:3000/", param: "", evidence: "", description: "", solution: "", reference: "" },
];

function mockClient(over: Partial<ZapClient> = {}): ZapClient & { activeScanCalled: boolean } {
  const self = {
    activeScanCalled: false,
    spider: vi.fn(async () => "1"),
    spiderStatus: vi.fn(async () => 100),
    activeScan: vi.fn(async () => { self.activeScanCalled = true; return "2"; }),
    activeScanStatus: vi.fn(async () => 100),
    alerts: vi.fn(async () => alerts),
    numberOfMessages: vi.fn(async () => 42),
    ...over,
  } as ZapClient & { activeScanCalled: boolean };
  return self;
}

describe("alcance", () => {
  it("respeta el alcance por origen y por prefijos", () => {
    expect(inScope("http://localhost:3000/a", "http://localhost:3000", [])).toBe(true);
    expect(inScope("http://otro.com/a", "http://localhost:3000", [])).toBe(false);
    expect(inScope("http://localhost:3000/api/x", "http://localhost:3000", ["http://localhost:3000/api"])).toBe(true);
    expect(inScope("http://localhost:3000/web", "http://localhost:3000", ["http://localhost:3000/api"])).toBe(false);
  });
});

describe("reporte", () => {
  it("agrupa alertas y cuenta por severidad y CWE", () => {
    const r = buildReport(cfg(), alerts, 42, 12, false);
    expect(r.counts).toEqual({ high: 1, medium: 1, low: 0, informational: 1 });
    const xss = r.findings.find((f) => f.name.includes("Scripting"))!;
    expect(xss.count).toBe(2);        // dos ocurrencias agrupadas
    expect(xss.cwe).toBe("CWE-79");
    expect(xss.severity).toBe("high");
    expect(r.findings[0].severity).toBe("high"); // ordenado: alto primero
    expect(r.findings.find((f) => f.name === "Info Disclosure")!.cwe).toBeNull();
  });
});

describe("ejecución", () => {
  it("escaneo pasivo: NO lanza escaneo activo", async () => {
    const client = mockClient();
    const r = await runSecurityScan({ config: cfg({ mode: "passive" }), client, pollMs: 1 });
    expect(client.activeScanCalled).toBe(false);
    expect(r.counts.high).toBe(1);
    expect(r.urlsScanned).toBe(42);
  });
  it("activo SIN autorización: NO lanza ataques", async () => {
    const client = mockClient();
    await runSecurityScan({ config: cfg({ mode: "active", authorizedActive: false }), client, pollMs: 1 });
    expect(client.activeScanCalled).toBe(false);
  });
  it("activo CON autorización: sí lanza el escaneo activo", async () => {
    const client = mockClient();
    await runSecurityScan({ config: cfg({ mode: "active", authorizedActive: true }), client, pollMs: 1 });
    expect(client.activeScanCalled).toBe(true);
  });
  it("se detiene antes si se lo piden", async () => {
    let n = 0;
    const client = mockClient({ spiderStatus: vi.fn(async () => (n += 20)) });
    const r = await runSecurityScan({ config: cfg(), client, pollMs: 1, shouldStop: () => true });
    expect(r.stoppedEarly).toBe(true);
  });
});
