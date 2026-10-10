import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { JobsModule } from "./jobs/jobs.module";
import { JobsService } from "./jobs/jobs.service";

/**
 * The background worker: a separate process from the API, built from the
 * same code. It runs every job once per interval. Running two workers is
 * safe, only wasteful.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(JobsModule, { logger: ["error", "warn"] });
  app.enableShutdownHooks();
  const jobs = app.get(JobsService);
  const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  console.log(`Worker running every ${intervalMs} ms`);
  while (!stopping) {
    try {
      const run = await jobs.runOnce();
      if (run.escalatedShortages || run.expiredReleasedUnits || run.expiredUnits) console.log("Worker run", run);
    } catch (err) {
      console.error("Worker run failed", err);
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, intervalMs);
    });
  }
  await app.close();
}

void main();
