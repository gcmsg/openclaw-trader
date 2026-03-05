/**
 * Reset paper trading accounts
 * Usage:
 *   npm run paper:reset -- <scenarioId>         Reset specified scenario
 *   npm run paper:reset -- all                  Reset all scenarios
 *   npm run paper:reset -- --kill-switch        Only release kill switch lock
 *   npm run paper:reset -- --scenario <id> --set-initial <usdt>   Reset base equity
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadPaperConfig } from "../config/loader.js";
import { getAccountPath } from "./account.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");
const KILL_SWITCH_PATH = path.join(LOGS_DIR, "kill-switch-state.json");

const args = process.argv.slice(2);

// ── --kill-switch mode ────────────────────────────────────────
if (args.includes("--kill-switch")) {
  if (fs.existsSync(KILL_SWITCH_PATH)) {
    const ks = JSON.parse(fs.readFileSync(KILL_SWITCH_PATH, "utf-8"));
    if (!ks.active) {
      console.log("ℹ️  Kill switch is not currently active, no reset needed.");
    } else {
      fs.writeFileSync(KILL_SWITCH_PATH, JSON.stringify({ active: false }, null, 2));
      console.log("✅ Kill switch has been deactivated.");
      console.log("   Original trigger info:", ks.reason ?? "not recorded", "/ Triggered at:", ks.triggeredAt ?? "unknown");
    }
  } else {
    console.log("ℹ️  Kill switch state file does not exist (default: inactive).");
  }
  process.exit(0);
}

// ── --set-initial mode ────────────────────────────────────────
const scenarioArg = args.find((a) => a.startsWith("--scenario="))?.split("=")[1]
  ?? (args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : undefined);
const setInitialArg = args.find((a) => a.startsWith("--set-initial="))?.split("=")[1]
  ?? (args.includes("--set-initial") ? args[args.indexOf("--set-initial") + 1] : undefined);

if (setInitialArg && scenarioArg) {
  const newInitial = parseFloat(setInitialArg);
  if (isNaN(newInitial) || newInitial <= 0) {
    console.error("❌ --set-initial must be a positive number, e.g.: --set-initial 8202");
    process.exit(1);
  }
  const stateFile = path.join(LOGS_DIR, `paper-${scenarioArg}.json`);
  if (!fs.existsSync(stateFile)) {
    console.error(`❌ State file not found: ${stateFile}`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const old = state.initialUsdt;
  state.initialUsdt = newInitial;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`✅ ${scenarioArg} initialUsdt: ${old} → ${newInitial}`);
  console.log("   P&L baseline updated, existing positions are not affected.");
  process.exit(0);
}

// ── Normal reset mode ──────────────────────────────────────────────
const target = args.filter((a) => !a.startsWith("--"))[0];

if (!target) {
  console.log(`
Usage: npm run paper:reset -- <scenarioId|all>      Reset accounts
       npm run paper:reset -- --kill-switch          Release kill switch lock
       npm run paper:reset -- --scenario <id> --set-initial <usdt>   Update P&L baseline

Examples:
  npm run paper:reset -- all
  npm run paper:reset -- testnet-default
  npm run paper:reset -- --kill-switch
  npm run paper:reset -- --scenario testnet-default --set-initial 8202
`);
  process.exit(1);
}

const paperCfg = loadPaperConfig();
const scenarios =
  target === "all" ? paperCfg.scenarios : paperCfg.scenarios.filter((s) => s.id === target);

if (scenarios.length === 0) {
  console.log(`Scenario not found: ${target}`);
  process.exit(1);
}

for (const s of scenarios) {
  const accountPath = getAccountPath(s.id);
  const statePath = path.join(LOGS_DIR, `state-${s.id}.json`);

  if (fs.existsSync(accountPath)) {
    fs.unlinkSync(accountPath);
    console.log(`✅ Account reset: ${s.name ?? s.id} (${path.basename(accountPath)})`);
  } else {
    console.log(`ℹ️  Account does not exist (skipped): ${s.name ?? s.id}`);
  }

  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
    console.log(`   State cleared: ${path.basename(statePath)}`);
  }
}

console.log("\n✅ Reset complete, new accounts will be created on next monitor scan");
