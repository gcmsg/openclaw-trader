#!/usr/bin/env tsx
/**
 * npm run doctor
 * One-click diagnosis of openclaw-trader runtime environment, outputs structured report
 *
 * Checks:
 * 1. Environment (Node version, dependencies)
 * 2. Config files (strategy.yaml, paper.yaml)
 * 3. API credentials & connectivity
 * 4. State file consistency (initialUsdt vs paper.yaml)
 * 5. Kill switch status
 * 6. Cron task status
 * 7. Log last active time
 * 8. Open positions summary
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "js-yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");
const LOGS = path.join(ROOT, "logs");
const SECRETS = path.join(ROOT, ".secrets");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

type Status = "ok" | "warn" | "fail" | "info";
interface CheckResult { label: string; status: Status; detail: string }

const results: CheckResult[] = [];

function record(label: string, status: Status, detail: string) {
  results.push({ label, status, detail });
}

function icon(s: Status) {
  return { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " }[s];
}

function color(s: Status) {
  return { ok: C.green, warn: C.yellow, fail: C.red, info: C.cyan }[s];
}

// ── 1. Node Version ──────────────────────────────────────────────
function checkNode() {
  const ver = process.version;
  const major = parseInt(ver.slice(1));
  if (major >= 18) record("Node.js Version", "ok", ver);
  else record("Node.js Version", "fail", `${ver} (requires v18+)`);
}

// ── 2. node_modules ───────────────────────────────────────────
function checkDeps() {
  const exists = fs.existsSync(path.join(ROOT, "node_modules"));
  if (exists) record("npm Dependencies", "ok", "node_modules exists");
  else record("npm Dependencies", "fail", "Not installed, please run npm install");
}

// ── 3. Config Files ───────────────────────────────────────────────
function checkConfigs() {
  const stratPath = path.join(ROOT, "config/strategy.yaml");
  const paperPath = path.join(ROOT, "config/paper.yaml");

  for (const [name, fp] of [["strategy.yaml", stratPath], ["paper.yaml", paperPath]] as const) {
    if (fs.existsSync(fp)) {
      try {
        yaml.load(fs.readFileSync(fp, "utf-8"));
        record(`Config ${name}`, "ok", "Exists and YAML syntax is valid");
      } catch (e) {
        record(`Config ${name}`, "fail", `YAML parse error: ${e}`);
      }
    } else {
      record(`Config ${name}`, "fail", "File does not exist");
    }
  }
}

// ── 4. API Credentials ───────────────────────────────────────────────
function checkSecrets() {
  const files = [
    { file: "binance-testnet.json", label: "Spot Testnet", required: false },
    { file: "binance-futures-testnet.json", label: "Futures Testnet", required: false },
    { file: "binance.json", label: "Live", required: false },
  ];

  let anyFound = false;
  for (const { file, label } of files) {
    const fp = path.join(SECRETS, file);
    if (!fs.existsSync(fp)) {
      record(`Credentials ${label}`, "info", `Not configured (${file} does not exist)`);
      continue;
    }
    try {
      const creds = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (!creds.apiKey || creds.apiKey.includes("your_")) {
        record(`Credentials ${label}`, "warn", "File exists but apiKey is a placeholder");
      } else {
        record(`Credentials ${label}`, "ok", `apiKey: ${creds.apiKey.slice(0, 8)}...`);
        anyFound = true;
      }
    } catch {
      record(`Credentials ${label}`, "fail", "JSON parse failed");
    }
  }

  if (!anyFound) {
    record("API Credentials", "warn", "No valid credentials found, run npm run setup to configure");
  }
}

// ── 5. State File vs paper.yaml Consistency ───────────────────────
function checkStateFiles() {
  const paperPath = path.join(ROOT, "config/paper.yaml");
  if (!fs.existsSync(paperPath)) return;

  let paperCfg: Record<string, unknown>;
  try {
    paperCfg = yaml.load(fs.readFileSync(paperPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const scenarios = (paperCfg["scenarios"] as Array<Record<string, unknown>>) ?? [];
  for (const scenario of scenarios) {
    const sid = scenario["id"] as string;
    if (!sid) continue;
    const configInitial = scenario["initial_usdt"] as number | undefined;
    const stateFile = path.join(LOGS, `paper-${sid}.json`);

    if (!fs.existsSync(stateFile)) continue;

    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const stateInitial = state.initialUsdt as number | undefined;

      if (configInitial && stateInitial && Math.abs(stateInitial - configInitial) > 1) {
        record(
          `State Consistency [${sid}]`,
          "warn",
          `state.initialUsdt=${stateInitial} does not match paper.yaml initial_usdt=${configInitial}. ` +
          `To reset P&L baseline, run: npm run paper:reset -- --scenario ${sid}`
        );
      } else {
        const posCount = Object.keys(state.positions ?? {}).length;
        const usdt = (state.usdt as number)?.toFixed(2) ?? "?";
        record(
          `State [${sid}]`,
          "ok",
          `initialUsdt=${stateInitial}, USDT=${usdt}, positions=${posCount}`
        );
      }
    } catch {
      record(`State [${sid}]`, "warn", "JSON parse failed");
    }
  }
}

// ── 6. Kill switch ────────────────────────────────────────────
function checkKillSwitch() {
  const fp = path.join(LOGS, "kill-switch-state.json");
  if (!fs.existsSync(fp)) {
    record("Kill Switch", "ok", "State file does not exist (not activated by default)");
    return;
  }
  try {
    const ks = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (ks.active) {
      record(
        "Kill Switch",
        "fail",
        `⛔ Activated! Triggered at ${ks.triggeredAt ?? "unknown"}, reason: ${ks.reason ?? "not recorded"}. ` +
        `Recovery: npm run paper:reset -- --kill-switch`
      );
    } else {
      record("Kill Switch", "ok", "Not activated");
    }
  } catch {
    record("Kill Switch", "warn", "State file parse failed");
  }
}

// ── 7. Cron Tasks ──────────────────────────────────────────────
function checkCron() {
  try {
    const crontab = execSync("crontab -l 2>/dev/null || echo ''", { encoding: "utf-8" });
    const traderLines = crontab.split("\n").filter((l) => l.includes("openclaw-trader"));
    if (traderLines.length === 0) {
      record("Cron Tasks", "warn", "No openclaw-trader cron found, run npm run cron:sync to sync");
    } else {
      record("Cron Tasks", "ok", `${traderLines.length} tasks registered`);
    }
  } catch {
    record("Cron Tasks", "warn", "Unable to read crontab");
  }
}

// ── 8. Log Activity Time ───────────────────────────────────────────
function checkLogs() {
  const logFiles = [
    { file: "live-monitor.log", label: "live-monitor" },
    { file: "price_monitor.log", label: "price-monitor" },
  ];

  for (const { file, label } of logFiles) {
    const fp = path.join(LOGS, file);
    if (!fs.existsSync(fp)) {
      record(`Log ${label}`, "info", "File does not exist (never run)");
      continue;
    }
    const stat = fs.statSync(fp);
    const ageMin = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMin < 5) {
      record(`Log ${label}`, "ok", `Active (updated ${ageMin.toFixed(1)} minutes ago)`);
    } else if (ageMin < 30) {
      record(`Log ${label}`, "warn", `${ageMin.toFixed(0)} minutes since last update`);
    } else {
      record(`Log ${label}`, "fail", `${(ageMin / 60).toFixed(1)} hours since last update, monitor may have stopped`);
    }
  }
}

// ── 9. Open Positions Summary ───────────────────────────────────────────
function checkPositions() {
  const stateFiles = fs.readdirSync(LOGS).filter(
    (f) => f.startsWith("paper-") && f.endsWith(".json") && !f.includes("backup")
  );
  let totalPositions = 0;
  for (const file of stateFiles) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(LOGS, file), "utf-8"));
      const positions = Object.keys(state.positions ?? {});
      if (positions.length > 0) {
        const sid = file.replace("paper-", "").replace(".json", "");
        record(
          `Positions [${sid}]`,
          "info",
          `${positions.length} open positions: ${positions.join(", ")}`
        );
        totalPositions += positions.length;
      }
    } catch { /* skip */ }
  }
  if (totalPositions === 0) {
    record("Positions Summary", "info", "No open positions currently");
  }
}

// ── Output Report ──────────────────────────────────────────────────
function printReport() {
  console.log(`
${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗
║          openclaw-trader  Doctor  🩺                 ║
╚══════════════════════════════════════════════════════╝${C.reset}
`);

  const maxLabel = Math.max(...results.map((r) => r.label.length));

  for (const r of results) {
    const col = color(r.status);
    const ic = icon(r.status);
    const pad = " ".repeat(maxLabel - r.label.length);
    console.log(`  ${ic} ${C.bold}${r.label}${C.reset}${pad}  ${col}${r.detail}${C.reset}`);
  }

  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;

  console.log(`\n  ${C.gray}─────────────────────────────────────────────────────${C.reset}`);
  if (fails === 0 && warns === 0) {
    console.log(`  ${C.bold}${C.green}🎉 All good, ready to start!${C.reset}`);
  } else {
    if (fails > 0) console.log(`  ${C.red}${C.bold}❌ ${fails} critical issue(s) need fixing${C.reset}`);
    if (warns > 0) console.log(`  ${C.yellow}⚠️  ${warns} warning(s) to address${C.reset}`);
  }
  console.log();
}

// ── Main Entry ───────────────────────────────────────────────────
checkNode();
checkDeps();
checkConfigs();
checkSecrets();
checkStateFiles();
checkKillSwitch();
checkCron();
checkLogs();
checkPositions();
printReport();
