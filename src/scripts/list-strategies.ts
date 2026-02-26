/**
 * 列出所有策略插件（F4）+ 可用 YAML 策略 profile
 * 用法: npm run strategies
 */

// 触发内置策略注册
import "../strategies/index.js";
import { listStrategyDetails } from "../strategies/registry.js";
import { listStrategyProfiles, loadStrategyProfile, loadPaperConfig } from "../config/loader.js";

const W = 60;
const line = "═".repeat(W);
const dash = "─".repeat(W);

// ─── 策略插件（代码层） ────────────────────────────────────
console.log(`\n${line}`);
console.log(`  🔌 策略插件 (src/strategies/)  [F4 Plugin System]`);
console.log(line);

const plugins = listStrategyDetails();
for (const p of plugins) {
  console.log(`  [${p.id}] ${p.name}`);
  if (p.description) console.log(`    ${p.description}`);
  console.log();
}

// ─── YAML 策略 profile（配置层） ────────────────────────────
console.log(dash);
console.log(`  📋 YAML 策略 profile (config/strategies/)`);
console.log(dash);

const profileIds = listStrategyProfiles();
const paperCfg = loadPaperConfig();

for (const id of profileIds) {
  const profile = loadStrategyProfile(id);
  const scenariosUsingThis = paperCfg.scenarios.filter((s) => s.strategy_id === id);
  const enabledCount = scenariosUsingThis.filter((s) => s.enabled).length;

  console.log(`  [${id}] ${profile.name}`);
  if (profile.description) console.log(`    ${profile.description}`);
  if (profile.strategy_id) {
    console.log(`    插件: ${profile.strategy_id}`);
  }
  if (scenariosUsingThis.length > 0) {
    console.log(
      `    场景: ${scenariosUsingThis.map((s) => `${s.name}${s.enabled ? "" : "(关闭)"}`).join(", ")}`
    );
    console.log(`    启用: ${enabledCount}/${scenariosUsingThis.length} 个`);
  }
  console.log();
}

// ─── 启用的场景 ─────────────────────────────────────────────
console.log(dash);
console.log(`  📊 启用的场景 (paper.yaml)`);
console.log(dash);

const enabled = paperCfg.scenarios.filter((s) => s.enabled);
const disabled = paperCfg.scenarios.filter((s) => !s.enabled);

for (const s of enabled) {
  const profile = loadStrategyProfile(s.strategy_id);
  const pluginTag = profile.strategy_id ? ` plugin:${profile.strategy_id}` : "";
  console.log(`  ✅ [${s.id}] ${s.name}  → profile: ${s.strategy_id}${pluginTag}  market: ${s.exchange.market}`);
}
for (const s of disabled) {
  console.log(`  ⬜ [${s.id}] ${s.name}  → profile: ${s.strategy_id}  market: ${s.exchange.market}`);
}

console.log(`${line}\n`);
console.log(`  💡 创建新插件策略：在 src/strategies/ 新建 .ts 文件并 registerStrategy()`);
console.log(`     在 src/strategies/index.ts 中 import 触发注册`);
console.log(`     在 config/strategies/*.yaml 中设置 strategy_id: "your-plugin-id"\n`);
