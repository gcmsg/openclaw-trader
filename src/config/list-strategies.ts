/**
 * 列出所有策略 + 当前启用的场景
 * 用法: npm run strategies:list
 */

import { listStrategyProfiles, loadStrategyProfile, loadPaperConfig } from "./loader.js";

const profileIds = listStrategyProfiles();
const paperCfg = loadPaperConfig();

console.log(`\n${"═".repeat(60)}`);
console.log(`  📋 可用策略 (config/strategies/)`);
console.log("═".repeat(60));

for (const id of profileIds) {
  const profile = loadStrategyProfile(id);
  const scenariosUsingThis = paperCfg.scenarios.filter((s) => s.strategy_id === id);
  const enabledCount = scenariosUsingThis.filter((s) => s.enabled).length;
  console.log(`  [${id}] ${profile.name}`);
  if (profile.description) console.log(`    ${profile.description}`);
  if (scenariosUsingThis.length > 0) {
    console.log(
      `    场景: ${scenariosUsingThis.map((s) => `${s.name}${s.enabled ? "" : "(关闭)"}`).join(", ")}`
    );
    console.log(`    启用: ${enabledCount}/${scenariosUsingThis.length} 个`);
  }
  console.log();
}

console.log("─".repeat(60));
console.log(`  📊 启用的场景 (paper.yaml)`);
console.log("─".repeat(60));

const enabled = paperCfg.scenarios.filter((s) => s.enabled);
const disabled = paperCfg.scenarios.filter((s) => !s.enabled);

for (const s of enabled) {
  console.log(
    `  ✅ [${s.id}] ${s.name}  → strategy: ${s.strategy_id}  market: ${s.exchange.market}`
  );
}
for (const s of disabled) {
  console.log(
    `  ⬜ [${s.id}] ${s.name}  → strategy: ${s.strategy_id}  market: ${s.exchange.market}`
  );
}
console.log(`${"═".repeat(60)}\n`);
console.log(`  💡 要添加新策略：在 config/strategies/ 创建 YAML 文件`);
console.log(`     要启用/禁用场景：编辑 config/paper.yaml 中的 enabled 字段\n`);
