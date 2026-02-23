/**
 * 重置模拟盘账户
 * 用法: npm run paper:reset <scenarioId>   重置指定场景
 *       npm run paper:reset all            重置所有场景
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadPaperConfig } from "../config/loader.js";
import { getAccountPath } from "./account.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");

const args = process.argv.slice(2);
const target = args[0];

if (!target) {
  console.log("用法: npm run paper:reset <scenarioId|all>");
  console.log("  npm run paper:reset all              重置全部");
  console.log("  npm run paper:reset conservative-spot  重置指定场景");
  process.exit(1);
}

const paperCfg = loadPaperConfig();
const scenarios = target === "all"
  ? paperCfg.scenarios
  : paperCfg.scenarios.filter((s) => s.id === target);

if (scenarios.length === 0) {
  console.log(`未找到场景: ${target}`);
  process.exit(1);
}

for (const s of scenarios) {
  const accountPath = getAccountPath(s.id);
  const statePath = path.join(LOGS_DIR, `state-${s.id}.json`);

  if (fs.existsSync(accountPath)) {
    fs.unlinkSync(accountPath);
    console.log(`✅ 已重置账户: ${s.name} (${accountPath})`);
  } else {
    console.log(`ℹ️  账户不存在（跳过）: ${s.name}`);
  }

  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
    console.log(`   已清除状态: ${statePath}`);
  }
}

console.log("\n✅ 重置完成，下次监控扫描时将自动建立新账户");
