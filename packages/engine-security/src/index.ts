import type { ScanSeverity, SecurityConfig, SecurityFinding, SecurityReport } from "@testforge/shared";

// Orquesta OWASP ZAP (en modo daemon) a través de su API REST.
// No implementa ataques: ZAP es el motor; aquí lo configuramos, lo lanzamos
// dentro del alcance autorizado y recogemos los hallazgos.

type ZapAlert = {
  name: string; risk: string; confidence: string; cweid: string; url: string;
  param: string; evidence: string; description: string; solution: string; reference: string;
};

const RISK_TO_SEVERITY: Record<string, ScanSeverity> = {
  High: "high", Medium: "medium", Low: "low", Informational: "informational",
};

export type ZapClient = {
  // Cada método corresponde a un endpoint de la API de ZAP
  spider(url: string): Promise<string>;              // devuelve id de escaneo
  spiderStatus(id: string): Promise<number>;         // 0..100
  activeScan(url: string): Promise<string>;
  activeScanStatus(id: string): Promise<number>;
  alerts(baseUrl: string): Promise<ZapAlert[]>;
  numberOfMessages(baseUrl: string): Promise<number>;
  includeInContext?(regex: string): Promise<void>;
  stopSpider?(id: string): Promise<void>;
  stopActiveScan?(id: string): Promise<void>;
};

// Cliente real contra la API HTTP de ZAP
export function httpZapClient(zapUrl: string, fetchImpl: typeof fetch = fetch): ZapClient {
  const base = zapUrl.replace(/\/+$/, "");
  const call = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${base}${path}`);
    if (!res.ok) throw new Error(`ZAP respondió ${res.status} en ${path}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  return {
    async spider(url) { return String((await call(`/JSON/spider/action/scan/?${q({ url, recurse: "true" })}`)).scan); },
    async spiderStatus(id) { return Number((await call(`/JSON/spider/view/status/?${q({ scanId: id })}`)).status); },
    async activeScan(url) { return String((await call(`/JSON/ascan/action/scan/?${q({ url, recurse: "true" })}`)).scan); },
    async activeScanStatus(id) { return Number((await call(`/JSON/ascan/view/status/?${q({ scanId: id })}`)).status); },
    async alerts(baseUrl) { return ((await call(`/JSON/alert/view/alerts/?${q({ baseurl: baseUrl })}`)).alerts as ZapAlert[]) ?? []; },
    async numberOfMessages(baseUrl) { return Number((await call(`/JSON/core/view/numberOfMessages/?${q({ baseurl: baseUrl })}`)).numberOfMessages ?? 0); },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Comprueba que una URL está dentro del alcance autorizado
export function inScope(url: string, targetUrl: string, scope: string[]): boolean {
  const prefixes = scope.length ? scope : [originPrefix(targetUrl)];
  return prefixes.some((p) => url.startsWith(p));
}
function originPrefix(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return url; }
}

export type SecurityRunOptions = {
  config: SecurityConfig;
  client: ZapClient;
  onProgress?: (p: { phase: string; percent: number }) => void | Promise<void>;
  shouldStop?: () => boolean | Promise<boolean>;
  pollMs?: number;
  now?: () => number;
};

export async function runSecurityScan(opts: SecurityRunOptions): Promise<SecurityReport> {
  const cfg = opts.config;
  const poll = opts.pollMs ?? 2000;
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + cfg.maxDurationMin * 60_000;
  let stoppedEarly = false;

  const stop = async () => {
    if (now() > deadline) return true;
    return Boolean(await opts.shouldStop?.());
  };

  // 1. Araña: descubre URLs dentro del sitio (se queda en el alcance por el target)
  await opts.onProgress?.({ phase: "Explorando el sitio", percent: 0 });
  const spiderId = await opts.client.spider(cfg.targetUrl);
  while (true) {
    const st = await opts.client.spiderStatus(spiderId);
    await opts.onProgress?.({ phase: "Explorando el sitio", percent: Math.min(50, Math.round(st / 2)) });
    if (st >= 100) break;
    if (await stop()) { stoppedEarly = true; await opts.client.stopSpider?.(spiderId).catch(() => {}); break; }
    await sleep(poll);
  }

  // 2. El escaneo pasivo de ZAP ocurre solo al ver el tráfico; esperamos un momento a que procese
  await opts.onProgress?.({ phase: "Análisis pasivo", percent: 55 });
  await sleep(poll);

  // 3. Escaneo activo: SOLO si el usuario lo autorizó explícitamente (envía ataques reales)
  if (cfg.mode === "active" && cfg.authorizedActive && !stoppedEarly) {
    await opts.onProgress?.({ phase: "Escaneo activo", percent: 60 });
    const scanId = await opts.client.activeScan(cfg.targetUrl);
    while (true) {
      const st = await opts.client.activeScanStatus(scanId);
      await opts.onProgress?.({ phase: "Escaneo activo", percent: 60 + Math.round(st * 0.35) });
      if (st >= 100) break;
      if (await stop()) { stoppedEarly = true; await opts.client.stopActiveScan?.(scanId).catch(() => {}); break; }
      await sleep(poll);
    }
  }

  // 4. Recoger hallazgos
  await opts.onProgress?.({ phase: "Recogiendo hallazgos", percent: 96 });
  const raw = await opts.client.alerts(cfg.targetUrl);
  const urlsScanned = await opts.client.numberOfMessages(cfg.targetUrl).catch(() => 0);

  const report = buildReport(cfg, raw, urlsScanned, Math.round((now() - started) / 1000), stoppedEarly);
  await opts.onProgress?.({ phase: "Terminado", percent: 100 });
  return report;
}

export function buildReport(cfg: SecurityConfig, raw: ZapAlert[], urlsScanned: number, durationSec: number, stoppedEarly: boolean): SecurityReport {
  // Agrupar alertas iguales (mismo nombre + severidad), contando ocurrencias
  const map = new Map<string, SecurityFinding>();
  for (const a of raw) {
    const severity = RISK_TO_SEVERITY[a.risk] ?? "informational";
    const key = `${a.name}|${severity}`;
    const existing = map.get(key);
    if (existing) { existing.count++; continue; }
    map.set(key, {
      name: a.name, severity, confidence: a.confidence,
      cwe: a.cweid && a.cweid !== "-1" && a.cweid !== "0" ? `CWE-${a.cweid}` : null,
      url: a.url, param: a.param ?? "", evidence: (a.evidence ?? "").slice(0, 300),
      description: a.description ?? "", solution: a.solution ?? "", reference: a.reference ?? "", count: 1,
    });
  }
  const order: ScanSeverity[] = ["high", "medium", "low", "informational"];
  const findings = [...map.values()].sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity));
  const counts: Record<ScanSeverity, number> = { high: 0, medium: 0, low: 0, informational: 0 };
  for (const f of findings) counts[f.severity]++;
  return { targetUrl: cfg.targetUrl, mode: cfg.mode, durationSec, urlsScanned, counts, findings, stoppedEarly };
}
