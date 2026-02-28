#!/usr/bin/env tsx
/**
 * 信号归因分析 CLI 入口
 *
 * 脚本职责：读取信号历史、调用领域模块分析、写入报告
 * 业务逻辑位于：src/analysis/attribution.ts
 *
 * 使用：npm run attribution
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
  console.log(`[attribution] 加载 ${records.length} 条信号记录`);

  const stats = analyzeGroups(records);
  const report = formatAttributionReport(stats, records);

  console.log("\n" + report);

  // 保存 JSON 报告
  fs.mkdirSync(path.dirname(ATTRIBUTION_REPORT_PATH), { recursive: true });
  fs.writeFileSync(
    ATTRIBUTION_REPORT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), stats }, null, 2)
  );
  console.log(`\n[attribution] JSON 报告已写入: ${ATTRIBUTION_REPORT_PATH}`);
}

main();
