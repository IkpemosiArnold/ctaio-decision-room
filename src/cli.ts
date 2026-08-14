import { runPipeline, saveRun, renderTrace, renderCard } from "./pipeline.js";
import { SOURCES } from "./sources.js";
import { defaultBackend } from "./model.js";

const backend = defaultBackend();
const runId = process.env.RUN_ID ?? "run_014";

const run = await runPipeline(SOURCES, { runId, backend });
saveRun(run);

console.log(`\nbackend: ${backend}\n`);
console.log(renderTrace(run));
console.log("\n" + "=".repeat(72) + "\n");
for (const card of run.cards) console.log(renderCard(card) + "\n" + "-".repeat(72) + "\n");
console.log("METRICS");
for (const [k, v] of Object.entries(run.metrics)) console.log(`  ${k}: ${v}`);
console.log(`\nstatus: ${run.status}`);
console.log(`saved: runs/${runId}.json`);
