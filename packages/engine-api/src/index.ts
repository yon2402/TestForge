import Ajv from "ajv";
import type {
  ApiRequestInput,
  Assertion,
  AssertionResult,
  ExecutedRequest,
  ExecutedResponse,
  RequestResult,
  RunSummary,
} from "@testforge/shared";

const MAX_BODY_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------- Variables {{nombre}} ----------
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

export function findMissingVariables(text: string, vars: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    if (!(m[1] in vars)) missing.add(m[1]);
  }
  return [...missing];
}

// ---------- JSON path simple: data.items[0].id, $.data.id, items.length ----------
export function getJsonPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  const clean = path.trim().replace(/^\$\.?/, "");
  if (clean === "") return { found: true, value: obj };
  const tokens = clean.match(/[^.[\]]+|\[(\d+)\]/g) ?? [];
  let current: unknown = obj;
  for (const raw of tokens) {
    const token = raw.startsWith("[") ? raw.slice(1, -1) : raw;
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (token === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = current.length;
      continue;
    }
    if (typeof current !== "object") return { found: false, value: undefined };
    if (!(token in (current as Record<string, unknown>))) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // "5" del formulario vs 5 del JSON: comparar como texto si los tipos difieren
  if (typeof a !== typeof b && a !== null && b !== null && typeof a !== "object" && typeof b !== "object") {
    return String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return haystack.some((item) => deepEqual(item, needle));
  return false;
}

const ajv = new Ajv({ allErrors: true, strict: false });

// ---------- Evaluar una aserción ----------
export function evaluateAssertion(
  assertion: Assertion,
  response: ExecutedResponse,
  durationMs: number,
): AssertionResult {
  const ok = (message: string, expected?: unknown, actual?: unknown): AssertionResult => ({
    assertion, passed: true, message, expected, actual,
  });
  const fail = (message: string, expected?: unknown, actual?: unknown): AssertionResult => ({
    assertion, passed: false, message, expected, actual,
  });

  switch (assertion.type) {
    case "status":
      return response.status === assertion.equals
        ? ok(`Código de estado es ${assertion.equals}`, assertion.equals, response.status)
        : fail(`Se esperaba código ${assertion.equals} y llegó ${response.status}`, assertion.equals, response.status);

    case "responseTime":
      return durationMs < assertion.lessThanMs
        ? ok(`Respondió en ${durationMs} ms (< ${assertion.lessThanMs} ms)`, assertion.lessThanMs, durationMs)
        : fail(`Tardó ${durationMs} ms, el límite es ${assertion.lessThanMs} ms`, assertion.lessThanMs, durationMs);

    case "header": {
      const actual = response.headers[assertion.name.toLowerCase()];
      if (assertion.op === "exists") {
        return actual !== undefined
          ? ok(`Cabecera ${assertion.name} presente`, undefined, actual)
          : fail(`Falta la cabecera ${assertion.name}`);
      }
      if (actual === undefined) return fail(`Falta la cabecera ${assertion.name}`, assertion.value);
      const pass = assertion.op === "equals" ? actual === assertion.value : actual.includes(assertion.value ?? "");
      const verb = assertion.op === "equals" ? "sea" : "contenga";
      return pass
        ? ok(`Cabecera ${assertion.name} cumple`, assertion.value, actual)
        : fail(`Se esperaba que ${assertion.name} ${verb} "${assertion.value}"`, assertion.value, actual);
    }

    case "jsonPath": {
      if (response.json === undefined) return fail("La respuesta no es JSON", assertion.path);
      const { found, value } = getJsonPath(response.json, assertion.path);
      if (assertion.op === "exists") {
        return found ? ok(`${assertion.path} existe`, undefined, value) : fail(`${assertion.path} no existe`);
      }
      if (!found) return fail(`${assertion.path} no existe`, assertion.value);
      if (assertion.op === "equals") {
        return deepEqual(value, assertion.value)
          ? ok(`${assertion.path} es igual al valor esperado`, assertion.value, value)
          : fail(`${assertion.path} no es igual al valor esperado`, assertion.value, value);
      }
      if (assertion.op === "notEquals") {
        return !deepEqual(value, assertion.value)
          ? ok(`${assertion.path} es distinto de ${JSON.stringify(assertion.value)}`, assertion.value, value)
          : fail(`${assertion.path} no debía ser ${JSON.stringify(assertion.value)}`, assertion.value, value);
      }
      return contains(value, assertion.value)
        ? ok(`${assertion.path} contiene el valor`, assertion.value, value)
        : fail(`${assertion.path} no contiene el valor`, assertion.value, value);
    }

    case "bodyContains":
      return response.body.includes(assertion.text)
        ? ok(`El cuerpo contiene "${assertion.text}"`)
        : fail(`El cuerpo no contiene "${assertion.text}"`, assertion.text);

    case "jsonSchema": {
      if (response.json === undefined) return fail("La respuesta no es JSON");
      let validate;
      try {
        validate = ajv.compile(assertion.schema);
      } catch (e) {
        return fail(`Esquema JSON inválido: ${(e as Error).message}`);
      }
      if (validate(response.json)) return ok("La respuesta cumple el esquema JSON");
      const errors = (validate.errors ?? []).map((er) => `${er.instancePath || "(raíz)"} ${er.message}`);
      return fail(`No cumple el esquema: ${errors.slice(0, 5).join("; ")}`, undefined, errors);
    }
  }
}

// ---------- Ejecutar un request ----------
export type ExecuteOptions = {
  variables?: Record<string, string>;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function resolveUrl(url: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(url) || !baseUrl) return url;
  return baseUrl.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

export async function executeRequest(req: ApiRequestInput & { id?: string }, opts: ExecuteOptions = {}): Promise<RequestResult> {
  const vars = opts.variables ?? {};
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[interpolate(k, vars)] = interpolate(v, vars);
  const body = req.body ? interpolate(req.body, vars) : null;
  const baseUrl = opts.baseUrl ? interpolate(opts.baseUrl, vars) : undefined;
  const url = resolveUrl(interpolate(req.url, vars), baseUrl);

  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    try {
      JSON.parse(body);
      headers["Content-Type"] = "application/json";
    } catch {
      /* no es JSON: se envía tal cual */
    }
  }

  const executed: ExecutedRequest = { method: req.method, url, headers, body };
  const base: Omit<RequestResult, "status" | "durationMs" | "response" | "assertions" | "error"> = {
    requestId: req.id,
    name: req.name,
    request: executed,
    captured: {},
  };

  const missing = findMissingVariables([url, body ?? "", ...Object.values(headers)].join("\n"), vars);
  if (missing.length) {
    return { ...base, status: "error", durationMs: 0, response: null, assertions: [],
      error: `Variables sin definir: ${missing.join(", ")}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = performance.now();
  let response: ExecutedResponse;
  let durationMs: number;
  try {
    const res = await doFetch(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body ?? undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    durationMs = Math.round(performance.now() - started);
    const truncated = buf.length > MAX_BODY_BYTES;
    const text = buf.subarray(0, MAX_BODY_BYTES).toString("utf8");
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => (resHeaders[key.toLowerCase()] = value));
    let json: unknown;
    if (!truncated) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    response = { status: res.status, statusText: res.statusText, headers: resHeaders, body: text, json,
      sizeBytes: buf.length, truncated };
  } catch (e) {
    durationMs = Math.round(performance.now() - started);
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const msg = err.name === "AbortError"
      ? `Tiempo de espera agotado (${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms)`
      : `No se pudo conectar: ${err.cause?.code ?? ""} ${err.cause?.message ?? err.message}`.trim();
    return { ...base, status: "error", durationMs, response: null, assertions: [], error: msg };
  } finally {
    clearTimeout(timer);
  }

  const assertions = (req.assertions ?? []).map((a) => evaluateAssertion(a, response, durationMs));

  const captured: Record<string, string> = {};
  for (const c of req.captures ?? []) {
    if (c.from === "header") {
      const v = response.headers[c.path.toLowerCase()];
      if (v !== undefined) captured[c.variable] = v;
    } else if (response.json !== undefined) {
      const { found, value } = getJsonPath(response.json, c.path);
      if (found) captured[c.variable] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }

  return { ...base, captured, response, durationMs, assertions,
    status: assertions.every((a) => a.passed) ? "passed" : "failed", error: null };
}

// ---------- Ejecutar una colección en orden (las capturas pasan al siguiente) ----------
export async function runCollection(
  requests: (ApiRequestInput & { id?: string })[],
  opts: ExecuteOptions & { onResult?: (r: RequestResult, index: number) => void | Promise<void> } = {},
): Promise<{ results: RequestResult[]; summary: RunSummary; variables: Record<string, string> }> {
  const variables = { ...(opts.variables ?? {}) };
  const results: RequestResult[] = [];
  const started = Date.now();
  for (const [i, req] of requests.entries()) {
    const r = await executeRequest(req, { ...opts, variables });
    Object.assign(variables, r.captured);
    results.push(r);
    await opts.onResult?.(r, i);
  }
  return { results, variables, summary: summarize(results, Date.now() - started) };
}

export function summarize(results: RequestResult[], durationMs: number): RunSummary {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    errors: results.filter((r) => r.status === "error").length,
    durationMs,
  };
}
