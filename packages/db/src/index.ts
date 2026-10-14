import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";

// Carga el .env de la raíz del repo, se ejecute desde donde se ejecute
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://testforge:testforge@localhost:5432/testforge",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  apiPort: Number(process.env.API_PORT ?? 4000),
  // Capturas, videos y trazas de las pruebas UI
  artifactsDir: resolve(dirname(fileURLToPath(import.meta.url)), "../../..", process.env.ARTIFACTS_DIR ?? "data/artifacts"),
  zapUrl: (process.env.ZAP_URL ?? "http://localhost:8090").replace(/\/+$/, ""),
};

export const sql = postgres(env.databaseUrl, {
  transform: postgres.camel, // columnas snake_case <-> propiedades camelCase
  onnotice: () => {},
});

export function redisConnection() {
  const u = new URL(env.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    maxRetriesPerRequest: null,
  };
}

// Esquema idempotente: se aplica al arrancar la API
export async function migrate() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      base_url text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS environments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      variables jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS api_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      method text NOT NULL,
      url text NOT NULL,
      headers jsonb NOT NULL DEFAULT '{}',
      body text,
      assertions jsonb NOT NULL DEFAULT '[]',
      captures jsonb NOT NULL DEFAULT '[]',
      sort_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
      kind text NOT NULL DEFAULT 'api',
      status text NOT NULL DEFAULT 'queued',
      trigger text NOT NULL DEFAULT 'manual',
      summary jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS run_results (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      request_id uuid,
      position int NOT NULL,
      name text NOT NULL,
      status text NOT NULL,
      duration_ms int NOT NULL,
      request jsonb NOT NULL,
      response jsonb,
      assertions jsonb NOT NULL DEFAULT '[]',
      captured jsonb NOT NULL DEFAULT '{}',
      error text
    );
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS ui_base_url text NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS ui_tests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      code text NOT NULL DEFAULT '',
      sort_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS stop_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS progress jsonb;
    CREATE TABLE IF NOT EXISTS load_samples (
      run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      t int NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS load_samples_run_idx ON load_samples(run_id, t);
    ALTER TABLE run_results ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'api';
    ALTER TABLE run_results ADD COLUMN IF NOT EXISTS browser text;
    ALTER TABLE run_results ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE run_results ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE run_results ADD COLUMN IF NOT EXISTS user_agent text;
    ALTER TABLE run_results ADD COLUMN IF NOT EXISTS code text;
    ALTER TABLE run_results ALTER COLUMN request DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS run_results_run_idx ON run_results(run_id, position);
    CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, created_at DESC);
  `);
}
