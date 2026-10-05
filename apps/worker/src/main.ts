import { Worker } from "bullmq";
import { redisConnection } from "@testforge/db";
import { RUN_QUEUE, type RunJob } from "@testforge/shared";
import { processRun } from "./processRun.js";

const worker = new Worker<RunJob>(
  RUN_QUEUE,
  async (job) => {
    console.log(`[worker] ejecución ${job.data.runId} iniciada`);
    const status = await processRun(job.data.runId);
    console.log(`[worker] ejecución ${job.data.runId} terminó: ${status}`);
    return status;
  },
  { connection: redisConnection(), concurrency: 4 },
);

worker.on("failed", (job, err) => console.error(`[worker] ejecución ${job?.data.runId} falló:`, err.message));
console.log("[worker] esperando ejecuciones…");

const shutdown = async () => { await worker.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
