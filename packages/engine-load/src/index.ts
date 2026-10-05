import { Agent, request } from "undici";
import { evaluateAssertion, getJsonPath, interpolate } from "@testforge/engine-api";
import type {
  ApiRequestInput, LoadConfig, LoadReport, LoadRequestStats, LoadSample, LoadThresholdResult,
} from "@testforge/shared";

// ---------- Etapas: cuántos usuarios virtuales hay en cada momento ----------
// Cada etapa lleva linealmente los usuarios del valor anterior a `target` en `durationSec`.
export type Stage = { durationSec: number; target: number };

export function buildStages(cfg: Pick<LoadConfig, "mode" | "vus" | "rampUpSec" | "durationSec">): Stage[] {
  const { vus, rampUpSec, durationSec } = cfg;
  const rampDown = Math.min(10, Math.max(2, Math.round((rampUpSec || 4) / 2)));
  switch (cfg.mode) {
    case "stress": {
      // Escalones crecientes de usuarios (20 %, 40 %… 100 %), cada uno con subida y meseta
      const step = durationSec / 5;
      const stages: Stage[] = [];
      for (let i = 1; i <= 5; i++) {
        const target = Math.max(1, Math.round((vus * i) / 5));
        stages.push({ durationSec: Math.max(1, step * 0.2), target }, { durationSec: Math.max(1, step * 0.8), target });
      }
      stages.push({ durationSec: rampDown, target: 0 });
      return stages;
    }
    case "spike": {
      // Carga base baja, un pico repentino y vuelta a la base
      const base = Math.max(1, Math.round(vus * 0.1));
      return [
        { durationSec: Math.max(1, rampUpSec), target: base },
        { durationSec: Math.max(1, durationSec * 0.3), target: base },
        { durationSec: 3, target: vus },
        { durationSec: Math.max(1, durationSec * 0.3), target: vus },
        { durationSec: 3, target: base },
        { durationSec: Math.max(1, durationSec * 0.4), target: base },
        { durationSec: rampDown, target: 0 },
      ];
    }
    case "load":
    case "soak":
    default:
      return [
        { durationSec: rampUpSec, target: vus },
        { durationSec, target: vus },
        { durationSec: rampDown, target: 0 },
      ];
  }
}

export const totalDuration = (stages: Stage[]) => stages.reduce((s, x) => s + x.durationSec, 0);

export function targetAt(stages: Stage[], elapsedSec: number): number {
  let from = 0, t = elapsedSec;
  for (const st of stages) {
    if (t <= st.durationSec) {
      const f = st.durationSec === 0 ? 1 : t / st.durationSec;
      return Math.max(0, Math.round(from + (st.target - from) * f));
    }
    t -= st.durationSec;
    from = st.target;
  }
  return 0;
}

// ---------- Estadísticas ----------
// Muestreo por reservorio: percentiles precisos sin guardar millones de latencias.
class Reservoir {
  private n = 0;
  readonly values: number[] = [];
  constructor(private readonly size = 2000) {}
  add(v: number) {
    this.n++;
    if (this.values.length < this.size) this.values.push(v);
    else {
      const j = Math.floor(Math.random() * this.n);
      if (j < this.size) this.values[j] = v;
    }
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

class Bucket {
  count = 0; errors = 0; sum = 0; min = Infinity; max = 0;
  readonly lat = new Reservoir();
  add(ms: number, error: boolean) {
    this.count++; if (error) this.errors++;
    this.sum += ms; if (ms < this.min) this.min = ms; if (ms > this.max) this.max = ms;
    this.lat.add(ms);
  }
  pct(ps: number[]) {
    const s = [...this.lat.values].sort((a, b) => a - b);
    return ps.map((p) => percentile(s, p));
  }
}

// ---------- Ejecución ----------
export type LoadRunOptions = {
  requests: (ApiRequestInput & { id?: string })[];
  config: LoadConfig;
  variables?: Record<string, string>;
  baseUrl?: string;
  onSample?: (s: LoadSample) => void | Promise<void>;
  shouldStop?: () => boolean | Promise<boolean>; // se consulta cada segundo (botón Detener)
  requestTimeoutMs?: number;
  fetchImpl?: typeof request; // para pruebas
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveUrl(url: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(url) || !baseUrl) return url;
  return baseUrl.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

export async function runLoadTest(opts: LoadRunOptions): Promise<{ samples: LoadSample[]; report: LoadReport }> {
  const cfg = opts.config;
  const doRequest = opts.fetchImpl ?? request;
  const stages = buildStages(cfg);
  const totalSec = totalDuration(stages);
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;
  const baseVars = opts.variables ?? {};

  // Un pool de conexiones compartido, dimensionado al número de usuarios
  const agent = new Agent({ connections: Math.min(cfg.vus, 1024), pipelining: 1, connectTimeout: timeoutMs });

  // Acumuladores globales y por request
  const overall = new Bucket();
  const perReq = new Map<string, Bucket & { name: string; method: string }>();
  const statusCodes: Record<string, number> = {};
  const errorCounts = new Map<string, number>();
  let totalRequests = 0, totalErrors = 0, peakRps = 0, maxVus = 0;

  // Ventana del segundo en curso (para las muestras en vivo)
  let win = new Bucket();
  const samples: LoadSample[] = [];

  const started = Date.now();
  let stopped = false;
  let rateTokens = 0; // control de maxRps por segundo
  let activeVus = 0;

  const bucketFor = (r: ApiRequestInput & { id?: string }) => {
    const key = r.id ?? `${r.method} ${r.name}`;
    let b = perReq.get(key);
    if (!b) { b = Object.assign(new Bucket(), { name: r.name, method: r.method }); perReq.set(key, b); }
    return b;
  };

  // Un usuario virtual: repite la colección hasta que se le pide parar
  async function virtualUser(stopUser: () => boolean) {
    const vuVars = { ...baseVars };
    while (!stopUser() && !stopped) {
      for (const req of opts.requests) {
        if (stopUser() || stopped) break;
        if (cfg.maxRps !== null) {
          // espera si ya se consumió el cupo de peticiones de este segundo
          while (rateTokens <= 0 && !stopped && !stopUser()) await sleep(2);
          rateTokens--;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers ?? {})) headers[interpolate(k, vuVars)] = interpolate(v, vuVars);
        const body = req.body ? interpolate(req.body, vuVars) : undefined;
        const url = resolveUrl(interpolate(req.url, vuVars), opts.baseUrl ? interpolate(opts.baseUrl, vuVars) : undefined);
        if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
          try { JSON.parse(body); headers["Content-Type"] = "application/json"; } catch { /* texto plano */ }
        }

        const t0 = performance.now();
        let error = false, statusCode = 0;
        try {
          const res = await doRequest(url, {
            method: req.method as never,
            headers,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
            dispatcher: agent,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
          });
          statusCode = res.statusCode;
          const text = await res.body.text(); // consume el cuerpo para liberar la conexión
          let json: unknown;
          try { json = JSON.parse(text); } catch { /* no json */ }

          if (cfg.validateAssertions && req.assertions?.length) {
            const resp = { status: statusCode, statusText: "", headers: {}, body: text, json, sizeBytes: text.length, truncated: false };
            const ms0 = performance.now() - t0;
            if (!req.assertions.every((a) => evaluateAssertion(a, resp, Math.round(ms0)).passed)) error = true;
          } else if (statusCode >= 400) {
            error = true;
          }
          // Captura de variables para los siguientes requests del mismo usuario
          for (const cap of req.captures ?? []) {
            if (cap.from === "jsonPath" && json !== undefined) {
              const { found, value } = getJsonPath(json, cap.path);
              if (found) vuVars[cap.variable] = typeof value === "string" ? value : JSON.stringify(value);
            }
          }
        } catch (e) {
          error = true;
          const code = (e as { code?: string }).code ?? (e as Error).name ?? "error";
          errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
        }
        const ms = Math.round(performance.now() - t0);

        totalRequests++; if (error) totalErrors++;
        statusCodes[statusCode || "sin respuesta"] = (statusCodes[statusCode || "sin respuesta"] ?? 0) + 1;
        overall.add(ms, error);
        win.add(ms, error);
        bucketFor(req).add(ms, error);

        if (cfg.thinkTimeMs > 0) await sleep(cfg.thinkTimeMs);
      }
    }
  }

  // Controlador: cada 100 ms ajusta cuántos usuarios hay; cada 1 s emite una muestra
  const users: { stop: boolean }[] = [];
  const spawn = () => {
    const h = { stop: false };
    users.push(h);
    activeVus++;
    void virtualUser(() => h.stop).finally(() => { activeVus--; });
  };

  let lastSampleSec = 0;
  const tick = 100;
  for (let elapsedMs = 0; ; elapsedMs += tick) {
    const elapsedSec = elapsedMs / 1000;
    if (elapsedSec >= totalSec) break;
    if (opts.shouldStop && (await opts.shouldStop())) { stopped = true; break; }

    const want = Math.min(cfg.vus, targetAt(stages, elapsedSec));
    while (users.filter((u) => !u.stop).length < want) spawn();
    while (users.filter((u) => !u.stop).length > want) {
      const u = users.find((x) => !x.stop); if (u) u.stop = true; else break;
    }
    maxVus = Math.max(maxVus, users.filter((u) => !u.stop).length);

    // Reparte el cupo de peticiones cada segundo
    if (cfg.maxRps !== null && Math.floor(elapsedSec) > Math.floor((elapsedMs - tick) / 1000)) rateTokens = cfg.maxRps;

    // Emite una muestra por segundo
    if (Math.floor(elapsedSec) > lastSampleSec) {
      lastSampleSec = Math.floor(elapsedSec);
      const [p50, p95, p99] = win.pct([50, 95, 99]);
      const rps = win.count;
      peakRps = Math.max(peakRps, rps);
      const sample: LoadSample = {
        t: lastSampleSec,
        vus: users.filter((u) => !u.stop).length,
        rps,
        errorRatePct: win.count ? round((win.errors / win.count) * 100) : 0,
        avgMs: win.count ? round(win.sum / win.count) : 0,
        p50Ms: round(p50), p95Ms: round(p95), p99Ms: round(p99),
      };
      samples.push(sample);
      await opts.onSample?.(sample);
      win = new Bucket();
    }
    await sleep(tick);
  }

  // Detener a todos y esperar a que terminen las peticiones en vuelo
  stopped = true;
  for (const u of users) u.stop = true;
  const deadline = Date.now() + timeoutMs + 1000;
  while (activeVus > 0 && Date.now() < deadline) await sleep(50);
  await agent.close().catch(() => {});

  const report = buildReport({ cfg, overall, perReq, statusCodes, errorCounts, totalRequests, totalErrors, peakRps, maxVus, durationSec: round((Date.now() - started) / 1000), stoppedEarly: stopped && lastSampleSec < totalSec - 1 && (await (opts.shouldStop?.() ?? false)) });
  return { samples, report };
}

function buildReport(a: {
  cfg: LoadConfig;
  overall: Bucket;
  perReq: Map<string, Bucket & { name: string; method: string }>;
  statusCodes: Record<string, number>;
  errorCounts: Map<string, number>;
  totalRequests: number; totalErrors: number; peakRps: number; maxVus: number; durationSec: number; stoppedEarly: boolean;
}): LoadReport {
  const [p50, p95, p99] = a.overall.pct([50, 95, 99]);
  const avgRps = a.durationSec > 0 ? round(a.totalRequests / a.durationSec) : 0;
  const errorRatePct = a.totalRequests ? round((a.totalErrors / a.totalRequests) * 100, 2) : 0;

  const perRequest: LoadRequestStats[] = [...a.perReq.values()].map((b) => {
    const [q50, q95, q99] = b.pct([50, 95, 99]);
    return {
      name: b.name, method: b.method, count: b.count, errors: b.errors,
      avgMs: b.count ? round(b.sum / b.count) : 0, minMs: b.min === Infinity ? 0 : round(b.min), maxMs: round(b.max),
      p50Ms: round(q50), p95Ms: round(q95), p99Ms: round(q99),
    };
  }).sort((x, y) => y.count - x.count);

  const topErrors = [...a.errorCounts.entries()].map(([message, count]) => ({ message, count }))
    .sort((x, y) => y.count - x.count).slice(0, 10);

  const th = a.cfg.thresholds;
  const thresholds: LoadThresholdResult[] = [];
  if (th.p95Ms !== null) thresholds.push({ name: "p95 de latencia", limit: `< ${th.p95Ms} ms`, actual: `${round(p95)} ms`, passed: p95 < th.p95Ms });
  if (th.errorRatePct !== null) thresholds.push({ name: "Tasa de error", limit: `< ${th.errorRatePct} %`, actual: `${errorRatePct} %`, passed: errorRatePct < th.errorRatePct });
  if (th.minRps !== null) thresholds.push({ name: "Peticiones por segundo", limit: `> ${th.minRps}`, actual: `${avgRps}`, passed: avgRps > th.minRps });

  return {
    totalRequests: a.totalRequests, totalErrors: a.totalErrors, errorRatePct,
    avgRps, peakRps: a.peakRps, maxVus: a.maxVus, durationSec: a.durationSec,
    avgMs: a.overall.count ? round(a.overall.sum / a.overall.count) : 0,
    p50Ms: round(p50), p95Ms: round(p95), p99Ms: round(p99), maxMs: a.overall.max === 0 ? 0 : round(a.overall.max),
    statusCodes: a.statusCodes, topErrors, perRequest, thresholds, stoppedEarly: a.stoppedEarly,
  };
}
