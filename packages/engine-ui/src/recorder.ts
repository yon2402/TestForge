import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

// Lanza el grabador de Playwright (codegen) en una ventana de navegador real.
// La persona navega y hace clics; al cerrar el navegador, devolvemos el código grabado,
// limpio para usarlo como cuerpo de una prueba de TestForge.
export async function recordUiTest(opts: { url?: string; browser?: "chromium" | "firefox" | "webkit"; timeoutMs?: number }): Promise<{ code: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tf-rec-"));
  const outFile = join(dir, "grabado.ts");
  const cli = require.resolve("@playwright/test/cli");

  const args = ["codegen", "--target", "playwright-test", "--output", outFile];
  if (opts.browser) args.push("--browser", opts.browser);
  if (opts.url) args.push(opts.url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 20 * 60_000);
    child.on("close", () => { clearTimeout(timer); resolve(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });

  let raw = "";
  try { raw = await readFile(outFile, "utf8"); } catch { /* el usuario cerró sin grabar */ }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return { code: extractBody(raw) };
}

// Del archivo que genera Playwright extraemos solo las líneas de dentro del test,
// convertimos a nuestro estilo (sin import, sin wrapper) y quitamos la fijación de credenciales.
export function extractBody(raw: string): string {
  if (!raw.trim()) return "";
  const testIdx = raw.indexOf("test(");
  if (testIdx === -1) {
    return raw.split("\n").filter((l) => !l.trimStart().startsWith("import ")).join("\n").trim();
  }
  // El cuerpo empieza en el primer "{" del "=> {" que sigue a test(...)
  const arrow = raw.indexOf("=> {", testIdx);
  if (arrow === -1) return raw.split("\n").filter((l) => !l.trimStart().startsWith("import ")).join("\n").trim();
  const bodyStart = arrow + "=> ".length + 1; // justo después de "{"
  let depth = 1, i = bodyStart;
  for (; i < raw.length && depth > 0; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") depth--;
  }
  const body = raw.slice(bodyStart, i - 1);
  return body.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trim() + "\n";
}
