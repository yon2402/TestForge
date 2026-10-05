import { z } from "zod";

// ---------- Aserciones ----------
export const assertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), equals: z.number().int() }),
  z.object({ type: z.literal("responseTime"), lessThanMs: z.number().positive() }),
  z.object({
    type: z.literal("header"),
    name: z.string().min(1),
    op: z.enum(["exists", "equals", "contains"]),
    value: z.string().optional(),
  }),
  z.object({
    type: z.literal("jsonPath"),
    path: z.string().min(1),
    op: z.enum(["exists", "equals", "contains", "notEquals"]),
    value: z.unknown().optional(),
  }),
  z.object({ type: z.literal("bodyContains"), text: z.string() }),
  z.object({ type: z.literal("jsonSchema"), schema: z.record(z.unknown()) }),
]);
export type Assertion = z.infer<typeof assertionSchema>;

// Guardar un valor de la respuesta en una variable para los requests siguientes
export const captureSchema = z.object({
  variable: z.string().min(1),
  from: z.enum(["jsonPath", "header"]),
  path: z.string().min(1),
});
export type Capture = z.infer<typeof captureSchema>;

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof httpMethods)[number];

export const apiRequestInput = z.object({
  name: z.string().min(1),
  method: z.enum(httpMethods),
  url: z.string().min(1),
  headers: z.record(z.string()).default({}),
  body: z.string().nullable().default(null),
  assertions: z.array(assertionSchema).default([]),
  captures: z.array(captureSchema).default([]),
  sortOrder: z.number().int().default(0),
});
export type ApiRequestInput = z.infer<typeof apiRequestInput>;
export type ApiRequest = ApiRequestInput & { id: string; projectId: string };

export const projectInput = z.object({
  name: z.string().min(1),
  baseUrl: z.string().default(""),
  uiBaseUrl: z.string().default(""),
});

// ---------- Pruebas UI (sintaxis Playwright) ----------
export const uiBrowsers = ["chromium", "firefox", "webkit"] as const;
export type UiBrowser = (typeof uiBrowsers)[number];

export const uiTestInput = z.object({
  name: z.string().min(1),
  code: z.string(),
  sortOrder: z.number().int().default(0),
});
export type UiTestInput = z.infer<typeof uiTestInput>;
export type UiTest = UiTestInput & { id: string; projectId: string };

// ---------- Pruebas de carga y estrés ----------
export const loadModes = ["load", "stress", "spike", "soak"] as const;
export type LoadMode = (typeof loadModes)[number];

export const loadConfigSchema = z.object({
  mode: z.enum(loadModes).default("load"),
  vus: z.number().int().min(1).max(5000),             // usuarios virtuales (máximo del perfil)
  rampUpSec: z.number().int().min(0).max(3600).default(10),
  durationSec: z.number().int().min(5).max(24 * 3600), // tiempo a plena carga (o total en estrés/picos)
  thinkTimeMs: z.number().int().min(0).max(60_000).default(0), // pausa entre requests de un usuario
  maxRps: z.number().int().min(1).max(100_000).nullable().default(null), // límite de peticiones/s
  validateAssertions: z.boolean().default(true),
  requestIds: z.array(z.string().uuid()).nullable().default(null), // null = todos los requests
  thresholds: z.object({
    p95Ms: z.number().positive().nullable().default(null),
    errorRatePct: z.number().min(0).max(100).nullable().default(null),
    minRps: z.number().positive().nullable().default(null),
  }).default({}),
});
export type LoadConfig = z.infer<typeof loadConfigSchema>;

export type LoadSample = {
  t: number; vus: number; rps: number; errorRatePct: number;
  avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number;
};
export type LoadRequestStats = {
  name: string; method: string; count: number; errors: number;
  avgMs: number; minMs: number; maxMs: number; p50Ms: number; p95Ms: number; p99Ms: number;
};
export type LoadThresholdResult = { name: string; limit: string; actual: string; passed: boolean };
export type LoadReport = {
  totalRequests: number; totalErrors: number; errorRatePct: number;
  avgRps: number; peakRps: number; maxVus: number; durationSec: number;
  avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number;
  statusCodes: Record<string, number>;
  topErrors: { message: string; count: number }[];
  perRequest: LoadRequestStats[];
  thresholds: LoadThresholdResult[];
  stoppedEarly: boolean;
};

// ---------- Escaneo de seguridad (OWASP ZAP) ----------
export const scanModes = ["passive", "active"] as const;
export type ScanMode = (typeof scanModes)[number];

export const securityConfigSchema = z.object({
  targetUrl: z.string().url("La URL objetivo no es válida"),
  mode: z.enum(scanModes).default("passive"),
  // Solo se siguen URLs que empiecen por alguno de estos prefijos (alcance)
  scope: z.array(z.string()).default([]),
  maxDurationMin: z.number().int().min(1).max(120).default(10),
  // El escaneo activo ENVÍA ataques; requiere confirmación explícita del usuario
  authorizedActive: z.boolean().default(false),
});
export type SecurityConfig = z.infer<typeof securityConfigSchema>;

export const scanSeverities = ["high", "medium", "low", "informational"] as const;
export type ScanSeverity = (typeof scanSeverities)[number];
export type SecurityFinding = {
  name: string; severity: ScanSeverity; confidence: string;
  cwe: string | null; url: string; param: string; evidence: string;
  description: string; solution: string; reference: string; count: number;
};
export type SecurityReport = {
  targetUrl: string; mode: ScanMode; durationSec: number;
  urlsScanned: number;
  counts: Record<ScanSeverity, number>;
  findings: SecurityFinding[];
  stoppedEarly: boolean;
};

export const environmentInput = z.object({
  name: z.string().min(1),
  variables: z.record(z.string()).default({}),
});

export const runInput = z.object({
  environmentId: z.string().uuid().nullable().optional(),
  trigger: z.enum(["manual", "ci"]).default("manual"),
  kind: z.enum(["api", "ui", "load", "security"]).default("api"),
  browsers: z.array(z.enum(uiBrowsers)).min(1).default(["chromium"]),
  // Si se indica, solo se ejecutan esas pruebas UI
  testIds: z.array(z.string().uuid()).optional(),
  // Solo para kind "load":
  load: loadConfigSchema.optional(),
  // Solo para kind "security":
  security: securityConfigSchema.optional(),
});
export type RunKind = "api" | "ui" | "load" | "security";


export type UiAttachment = { name: string; contentType: string; path: string };
export type UiStep = { title: string; durationMs: number; error: string | null };

// ---------- Resultados ----------
export type AssertionResult = {
  assertion: Assertion;
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export type ExecutedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

export type ExecutedResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  json?: unknown;
  sizeBytes: number;
  truncated: boolean;
};

export type RequestResult = {
  requestId?: string;
  name: string;
  status: "passed" | "failed" | "error";
  durationMs: number;
  request: ExecutedRequest;
  response: ExecutedResponse | null;
  assertions: AssertionResult[];
  captured: Record<string, string>;
  error: string | null;
};

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error";

export type RunSummary = {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
  load?: LoadReport; // solo en ejecuciones de carga
  security?: SecurityReport; // solo en escaneos de seguridad
};

export const RUN_QUEUE = "testforge-runs";
export type RunJob = { runId: string };

export * from "./import.js";
