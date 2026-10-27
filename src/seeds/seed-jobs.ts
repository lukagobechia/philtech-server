// Dev/demo seed: creates the sample vacancies previously hardcoded in the frontend dictionaries.
import { readFile } from "node:fs/promises";
import { AppDataSource } from "../config/database.js";
import { Job } from "../entities/job.entity.js";
import { createJobBody } from "../modules/jobs/jobs.schema.js";
import { createJob } from "../modules/jobs/jobs.service.js";

const seed = JSON.parse(await readFile(new URL("./jobs.seed.json", import.meta.url), "utf8")) as unknown[];

await AppDataSource.initialize();
try {
    for (const raw of seed) {
        const input = createJobBody.parse({ ...(raw as object), isPublished: true });
        if (await AppDataSource.getRepository(Job).existsBy({ slug: input.slug })) {
            console.log(`skip ${input.slug} (exists)`);
            continue;
        }
        await createJob(input);
        console.log(`created ${input.slug}`);
    }
} finally {
    await AppDataSource.destroy();
}
