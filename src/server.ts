import { app } from "./app.js";
import { env } from "./config/env.js";
import { AppDataSource } from "./config/database.js";
import { logger } from "./config/logger.js";
import { startOutboxWorker } from "./modules/email/outbox.worker.js";
import { startOvertimeScheduler } from "./modules/employees/employees.service.js";
import { startJobScheduler } from "./modules/jobs/jobs.service.js";
import { startRetentionJob } from "./modules/maintenance/retention.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function bootstrap(): Promise<void> {
  await AppDataSource.initialize();

  const stopOutbox = startOutboxWorker(AppDataSource);
  const stopRetention = startRetentionJob();
  const stopJobScheduler = startJobScheduler();
  const stopOvertimeScheduler = startOvertimeScheduler();

  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received. Shutting down...`);

    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    stopRetention();
    stopJobScheduler();
    stopOvertimeScheduler();

    server.close(async (error) => {
      try {
        await stopOutbox();

        if (AppDataSource.isInitialized) {
          await AppDataSource.destroy();
        }

        if (error) {
          logger.error({ err: error }, "HTTP server shutdown failed");
          process.exitCode = 1;
        }
      } catch (shutdownError) {
        logger.error({ err: shutdownError }, "Database shutdown failed");
        process.exitCode = 1;
      }
    });
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, "Application startup failed");
  process.exitCode = 1;
});
