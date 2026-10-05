#!/usr/bin/env node
// Punto de entrada compilado-ligero: ejecuta la CLI con tsx sin paso de build
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath,
  ["--import", "tsx", resolve(here, "src/index.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
