#!/usr/bin/env node
/**
 * Usage:
 *   node --env-file=.env scripts/import-firestore.js --dir=./export [--dry-run] [--only=manufacturer,tags] [--report=./reports]
 *
 * Reads local JSON export files only. It never connects to Firebase and never deletes anything.
 */
import fs from "node:fs";
import path from "node:path";
import { loadExport } from "../src/migration/loader.js";
import { COLLECTION_ORDER, runImport } from "../src/migration/importer.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
if (!args.dir) {
  console.error("Missing --dir=<export directory>");
  process.exit(2);
}
const only =
  typeof args.only === "string"
    ? args.only.split(",").map((s) => s.trim())
    : undefined;
if (only) {
  const bad = only.filter((c) => !COLLECTION_ORDER.includes(c));
  if (bad.length) {
    console.error(
      `Unknown collection(s): ${bad.join(", ")}\nValid: ${COLLECTION_ORDER.join(", ")}`,
    );
    process.exit(2);
  }
}

const { prisma } = await import("../src/config/prisma.js");
const data = loadExport(path.resolve(args.dir));
console.log(`${args["dry-run"] ? "[DRY RUN] " : ""}Importing from ${args.dir}`);

try {
  const result = await runImport({
    prisma,
    data,
    dryRun: Boolean(args["dry-run"]),
    only,
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
  });

  const dir = path.resolve(
    typeof args.report === "string" ? args.report : "./reports",
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `import-${new Date().toISOString().replace(/[:.]/g, "-")}${args["dry-run"] ? "-dry" : ""}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(result, null, 2));

  console.table(result.stats);
  console.log(
    `warnings: ${result.warnings.length}, failures: ${result.failures.length}`,
  );
  const show = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`\n${title}:`);
    for (const r of rows) console.log(`  - [${r.collection}] ${fmt(r)}`);
  };
  show(
    "FAILURES (fix these first)",
    result.failures,
    (r) => `${r.id}: ${r.reason}`,
  );
  show("WARNINGS", result.warnings, (r) => `${r.id}: ${r.message}`);
  console.log();
  console.log(`full report: ${file}`);
  process.exitCode = result.failures.length ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
