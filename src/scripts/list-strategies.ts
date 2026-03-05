/**
 * List all strategy plugins (F4) + available YAML strategy profiles
 * Usage: npm run strategies
 */

// Trigger built-in strategy registration
import "../strategies/index.js";
import { listStrategyDetails } from "../strategies/registry.js";
import { listStrategyProfiles, loadStrategyProfile, loadPaperConfig } from "../config/loader.js";

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

const W = 60;
const line = "═".repeat(W);
const dash = "─".repeat(W);

// ─── Strategy Plugins (Code Layer) ────────────────────────────────────
console.log(`\n${line}`);
console.log(`  🔌 Strategy Plugins (src/strategies/)  [F4 Plugin System]`);
console.log(line);

const plugins = listStrategyDetails();
for (const p of plugins) {
  console.log(`  [${p.id}] ${p.name}`);
  if (p.description) console.log(`    ${p.description}`);
  console.log();
}

// ─── YAML Strategy Profiles (Config Layer) ────────────────────────────
console.log(dash);
console.log(`  📋 YAML Strategy Profiles (config/strategies/)`);
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
    console.log(`    Plugin: ${profile.strategy_id}`);
  }
  if (scenariosUsingThis.length > 0) {
    console.log(
      `    Scenarios: ${scenariosUsingThis.map((s) => `${s.name}${s.enabled ? "" : "(disabled)"}`).join(", ")}`
    );
    console.log(`    Enabled: ${enabledCount}/${scenariosUsingThis.length}`);
  }
  console.log();
}

// ─── Enabled Scenarios ─────────────────────────────────────────────
console.log(dash);
console.log(`  📊 Enabled Scenarios (paper.yaml)`);
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
console.log(`  💡 To create a new plugin strategy: create a .ts file in src/strategies/ and call registerStrategy()`);
console.log(`     Import it in src/strategies/index.ts to trigger registration`);
console.log(`     Set strategy_id: "your-plugin-id" in config/strategies/*.yaml\n`);
