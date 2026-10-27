import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

let container: StartedPostgreSqlContainer;

export async function setup(project: TestProject) {
    container = await new PostgreSqlContainer("postgres:16").start();
    project.provide("databaseUrl", container.getConnectionUri());
}

export async function teardown() {
    await container?.stop();
}

declare module "vitest" {
    export interface ProvidedContext {
        databaseUrl: string;
    }
}
