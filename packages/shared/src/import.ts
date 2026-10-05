import type { ApiRequestInput, Assertion, HttpMethod } from "./index.js";
import { httpMethods } from "./index.js";

// Convierte colecciones externas a requests de TestForge.
// Soporta: Postman Collection v2.1 y OpenAPI 3.x (JSON).

export type ImportResult = {
  format: "postman" | "openapi";
  name: string;
  requests: ApiRequestInput[];
  variables: Record<string, string>; // variables sugeridas para el entorno
  warnings: string[];
};

const asMethod = (m: string): HttpMethod => {
  const up = m.toUpperCase();
  return (httpMethods as readonly string[]).includes(up) ? (up as HttpMethod) : "GET";
};

// Postman usa {{var}}; TestForge también, así que las variables pasan tal cual.
// OpenAPI usa {param} en la ruta; lo convertimos a {{param}}.

export function detectFormat(json: unknown): "postman" | "openapi" | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (o.info && typeof o.info === "object" && (o.item || (o.info as Record<string, unknown>).schema)) return "postman";
  if (typeof o.openapi === "string" || o.swagger) return "openapi";
  return null;
}

export function parseImport(json: unknown): ImportResult {
  const fmt = detectFormat(json);
  if (fmt === "postman") return parsePostman(json as PostmanCollection);
  if (fmt === "openapi") return parseOpenApi(json as OpenApiDoc);
  throw new Error("Formato no reconocido. Debe ser una colección de Postman v2.1 o un archivo OpenAPI 3 en JSON.");
}

// ---------- Postman ----------
type PostmanUrl = string | { raw?: string; host?: string[]; path?: string[]; query?: { key: string; value: string; disabled?: boolean }[] };
type PostmanHeader = { key: string; value: string; disabled?: boolean };
type PostmanBody = { mode?: string; raw?: string; urlencoded?: { key: string; value: string; disabled?: boolean }[] };
type PostmanRequest = { method?: string; url?: PostmanUrl; header?: PostmanHeader[]; body?: PostmanBody };
type PostmanItem = { name?: string; request?: PostmanRequest; item?: PostmanItem[]; event?: { listen: string; script?: { exec?: string[] } }[] };
type PostmanCollection = { info?: { name?: string }; item?: PostmanItem[]; variable?: { key: string; value: string }[] };

function urlToString(url: PostmanUrl | undefined): string {
  if (!url) return "";
  if (typeof url === "string") return url;
  if (url.raw) return url.raw;
  const host = (url.host ?? []).join(".");
  const path = (url.path ?? []).join("/");
  const q = (url.query ?? []).filter((x) => !x.disabled).map((x) => `${x.key}=${x.value}`).join("&");
  return `${host}${path ? "/" + path : ""}${q ? "?" + q : ""}`;
}

// Traduce aserciones simples de los tests de Postman (pm.response / pm.expect)
function assertionsFromScript(exec: string[]): Assertion[] {
  const code = exec.join("\n");
  const out: Assertion[] = [];
  const statusEq = code.match(/\.to\.have\.status\((\d{3})\)|\.code\)?\.to\.(?:eql|equal)\((\d{3})\)|status(?:Code)?\s*(?:to\.be|===|==)\s*(\d{3})/);
  if (statusEq) {
    const code3 = statusEq[1] ?? statusEq[2] ?? statusEq[3];
    if (code3) out.push({ type: "status", equals: Number(code3) });
  }
  if (/pm\.response\.to\.be\.ok|to\.have\.status\(200\)/.test(code) && !out.length) out.push({ type: "status", equals: 200 });
  const resTime = code.match(/responseTime\)?\.to\.be\.below\((\d+)\)/);
  if (resTime) out.push({ type: "responseTime", lessThanMs: Number(resTime[1]) });
  const bodyHas = code.match(/pm\.expect\(pm\.response\.text\(\)\)\.to\.include\(["'`]([^"'`]+)["'`]\)/);
  if (bodyHas) out.push({ type: "bodyContains", text: bodyHas[1] });
  return out;
}

function walkPostman(items: PostmanItem[], acc: ApiRequestInput[], prefix: string, warnings: string[]) {
  for (const it of items) {
    if (it.item) { walkPostman(it.item, acc, prefix ? `${prefix} / ${it.name ?? ""}` : it.name ?? "", warnings); continue; }
    if (!it.request) continue;
    const r = it.request;
    const headers: Record<string, string> = {};
    for (const h of r.header ?? []) if (!h.disabled) headers[h.key] = h.value;
    let body: string | null = null;
    if (r.body?.mode === "raw" && r.body.raw) body = r.body.raw;
    else if (r.body?.mode === "urlencoded" && r.body.urlencoded) {
      body = r.body.urlencoded.filter((x) => !x.disabled).map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value)}`).join("&");
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (r.body?.mode && r.body.mode !== "raw") {
      warnings.push(`"${it.name}": el cuerpo tipo ${r.body.mode} no se importó (solo raw y urlencoded).`);
    }
    const testEvent = (it.event ?? []).find((e) => e.listen === "test");
    const assertions = testEvent?.script?.exec ? assertionsFromScript(testEvent.script.exec) : [];
    acc.push({
      name: it.name ?? `${r.method ?? "GET"} ${urlToString(r.url)}`.slice(0, 80),
      method: asMethod(r.method ?? "GET"),
      url: urlToString(r.url),
      headers, body, assertions, captures: [], sortOrder: acc.length,
    });
  }
}

function parsePostman(col: PostmanCollection): ImportResult {
  const requests: ApiRequestInput[] = [];
  const warnings: string[] = [];
  walkPostman(col.item ?? [], requests, "", warnings);
  const variables: Record<string, string> = {};
  for (const v of col.variable ?? []) variables[v.key] = v.value;
  return { format: "postman", name: col.info?.name ?? "Colección importada", requests, variables, warnings };
}

// ---------- OpenAPI ----------
type OpenApiOp = { operationId?: string; summary?: string; parameters?: { name: string; in: string; required?: boolean; example?: unknown }[];
  requestBody?: { content?: Record<string, { example?: unknown; schema?: unknown }> }; responses?: Record<string, unknown> };
type OpenApiDoc = { openapi?: string; swagger?: string; info?: { title?: string };
  servers?: { url: string }[]; paths?: Record<string, Record<string, OpenApiOp>> };

function exampleBody(op: OpenApiOp): string | null {
  const json = op.requestBody?.content?.["application/json"];
  if (!json) return null;
  if (json.example !== undefined) return JSON.stringify(json.example, null, 2);
  const ex = buildExampleFromSchema(json.schema);
  return ex === undefined ? null : JSON.stringify(ex, null, 2);
}

function buildExampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 5) return undefined;
  const s = schema as Record<string, unknown>;
  if (s.example !== undefined) return s.example;
  if (s.type === "object" || s.properties) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((s.properties as Record<string, unknown>) ?? {})) {
      const ex = buildExampleFromSchema(v, depth + 1);
      if (ex !== undefined) obj[k] = ex;
    }
    return obj;
  }
  if (s.type === "array") return [buildExampleFromSchema(s.items, depth + 1)].filter((x) => x !== undefined);
  if (s.type === "integer" || s.type === "number") return 0;
  if (s.type === "boolean") return false;
  if (s.type === "string") return (s.format as string) === "date-time" ? "2024-01-01T00:00:00Z" : "texto";
  return undefined;
}

function parseOpenApi(doc: OpenApiDoc): ImportResult {
  const requests: ApiRequestInput[] = [];
  const warnings: string[] = [];
  const base = doc.servers?.[0]?.url ?? "";
  const variables: Record<string, string> = {};
  if (base) variables.host = base;

  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!(httpMethods as readonly string[]).includes(method.toUpperCase())) continue;
      // {param} → {{param}}; la ruta se une a {{host}}
      let url = path.replace(/\{([^}]+)\}/g, "{{$1}}");
      if (base) url = "{{host}}" + url;
      const headers: Record<string, string> = {};
      const body = exampleBody(op);
      if (body) headers["Content-Type"] = "application/json";
      for (const p of op.parameters ?? []) {
        if (p.in === "header") headers[p.name] = p.example !== undefined ? String(p.example) : `{{${p.name}}}`;
        if (p.in === "path") variables[p.name] = p.example !== undefined ? String(p.example) : "";
      }
      const okCode = Object.keys(op.responses ?? {}).find((c) => c.startsWith("2"));
      const assertions: Assertion[] = okCode && /^\d{3}$/.test(okCode) ? [{ type: "status", equals: Number(okCode) }] : [];
      requests.push({
        name: op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`,
        method: asMethod(method), url, headers, body, assertions, captures: [], sortOrder: requests.length,
      });
    }
  }
  return { format: "openapi", name: doc.info?.title ?? "API importada", requests, variables, warnings };
}
