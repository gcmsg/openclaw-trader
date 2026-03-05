#!/usr/bin/env tsx
/**
 * Signal Attribution Analysis CLI Entry
 *
 * Script responsibility: read signal history, call domain module analysis, write report
 * Business logic located at: src/analysis/attribution.ts
 *
 * Usage: npm run attribution
 */

import fs from "fs";
import path from "path";
import {
  loadAttributionHistory,
  analyzeGroups,
  formatAttributionReport,
  ATTRIBUTION_REPORT_PATH,
} from "../analysis/attribution.js";

function main(): void {
  const records = loadAttributionHistory();
  console.log(`[attribution] Loaded ${records.length} signal records`);

  const stats = analyzeGroups(records);
  const report = formatAttributionReport(stats, records);

  console.log("\n" + report);

  // Save JSON report
  fs.mkdirSync(path.dirname(ATTRIBUTION_REPORT_PATH), { recursive: true });
  fs.writeFileSync(
    ATTRIBUTION_REPORT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), stats }, null, 2)
  );
  console.log(`\n[attribution] JSON report written to: ${ATTRIBUTION_REPORT_PATH}`);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main();
