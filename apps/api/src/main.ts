import { Queue } from "bullmq";
import { env, migrate, redisConnection } from "@testforge/db";
import { RUN_QUEUE, type RunJob } from "@testforge/shared";
import { buildServer } from "./server.js";

await migrate();
const queue = new Queue<RunJob>(RUN_QUEUE, { connection: redisConnection() });
const app = await buildServer(queue);
await app.listen({ port: env.apiPort, host: "0.0.0.0" });
