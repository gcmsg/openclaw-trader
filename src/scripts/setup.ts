#!/usr/bin/env tsx
/**
 * openclaw-trader First-time Setup Wizard
 * Usage: npm run setup
 *
 * Features:
 * 1. Detect and create .secrets/ credential files
 * 2. Guide user to fill in paper.yaml basic parameters
 * 3. Verify Binance API connectivity
 * 4. Sync cron tasks
 * 5. Output next-step instructions
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { execSync } from "child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SECRETS_DIR = path.join(ROOT, ".secrets");

// ─── ANSI Colors ─────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const ok = (s: string) => `${C.green}✅ ${s}${C.reset}`;
const warn = (s: string) => `${C.yellow}⚠️  ${s}${C.reset}`;
const err = (s: string) => `${C.red}❌ ${s}${C.reset}`;
const info = (s: string) => `${C.cyan}ℹ️  ${s}${C.reset}`;
const step = (n: number, s: string) => `\n${C.bold}${C.cyan}[${n}] ${s}${C.reset}`;

// ─── readline Utilities ──────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));
const askDefault = async (q: string, def: string): Promise<string> => {
  const ans = await ask(`${q} ${C.gray}[${def}]${C.reset} `);
  return ans.trim() || def;
};
const confirm = async (q: string, def = true): Promise<boolean> => {
  const hint = def ? "Y/n" : "y/N";
  const ans = await ask(`${q} ${C.gray}[${hint}]${C.reset} `);
  if (!ans.trim()) return def;
  return ans.trim().toLowerCase().startsWith("y");
};

// ─── Main Flow ────────────────────────────────────────────────────
async function main() {
  console.log(`
${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗
║         openclaw-trader  Setup Wizard  🚀            ║
╚══════════════════════════════════════════════════════╝${C.reset}
`);

  // ── Step 1: Node version check ────────────────────────────────
  console.log(step(1, "Environment Check"));
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1));
  if (major < 18) {
    console.log(err(`Node.js ${nodeVer} is too old, requires v18+. Please upgrade before running.`));
    process.exit(1);
  }
  console.log(ok(`Node.js ${nodeVer}`));

  // ── Step 2: npm install ───────────────────────────────────────
  console.log(step(2, "Dependency Installation"));
  const nmExists = fs.existsSync(path.join(ROOT, "node_modules"));
  if (!nmExists) {
    console.log(info("node_modules not found, installing dependencies..."));
    execSync("npm install", { cwd: ROOT, stdio: "inherit" });
  } else {
    console.log(ok("node_modules already exists, skipping installation"));
  }

  // ── Step 3: .secrets configuration ─────────────────────────────
  console.log(step(3, "Binance API Credentials"));
  console.log(`
${C.yellow}📌 Important: Testnet has two independent systems, each requires its own API Key${C.reset}

  ${C.bold}Spot Testnet${C.reset} (testnet.binance.vision)
  → Apply at: https://testnet.binance.vision/  (login with GitHub account)
  → Used for: spot simulated trading

  ${C.bold}Futures Testnet${C.reset} (testnet.binancefuture.com)
  → Apply at: https://testnet.binancefuture.com/  (separate registration)
  → Used for: futures simulated trading

  ${C.bold}Live${C.reset} (binance.com)
  → Create API Key in account management
  → ⚠️  Live operations require explicit user authorization, Agent will not auto-trade after setup
`);

  fs.mkdirSync(SECRETS_DIR, { recursive: true });

  await setupSecretFile(
    "binance-testnet.json",
    "Spot Testnet (testnet.binance.vision)",
    "testnet.binance.vision"
  );

  const setupFutures = await confirm(
    "\nConfigure Futures Testnet (testnet.binancefuture.com)?",
    false
  );
  if (setupFutures) {
    await setupSecretFile(
      "binance-futures-testnet.json",
      "Futures Testnet (testnet.binancefuture.com)",
      "testnet.binancefuture.com"
    );
  }

  const setupLive = await confirm(
    "\nConfigure live API Key (binance.com)?",
    false
  );
  if (setupLive) {
    await setupSecretFile("binance.json", "Live (binance.com)", "binance.com");
  }

  // ── Step 4: paper.yaml basic parameters ───────────────────────
  console.log(step(4, "Paper Trading Basic Config"));
  const paperYamlPath = path.join(ROOT, "config/paper.yaml");
  const paperContent = fs.readFileSync(paperYamlPath, "utf-8");

  console.log(`
Currently enabled scenarios (enabled: true):`);

  // Simple parse to show enabled scenarios
  const enabledScenarios: string[] = [];
  let currentId = "";
  for (const line of paperContent.split("\n")) {
    const idMatch = line.match(/^\s+- id:\s+"?([^"]+)"?/);
    if (idMatch?.[1]) currentId = idMatch[1];
    if (line.includes("enabled: true") && currentId) {
      enabledScenarios.push(currentId);
    }
  }
  enabledScenarios.forEach((s) => console.log(`  ${C.green}✓${C.reset} ${s}`));

  const editPaper = await confirm(
    "\nWould you like to modify testnet-default initial capital (initial_usdt)?",
    false
  );
  if (editPaper) {
    const current = paperContent.match(/initial_usdt:\s*(\d+)/)?.[1] ?? "3000";
    const newVal = await askDefault(`Initial USDT (currently ${current}):`, current);
    if (newVal !== current) {
      // Only update the first testnet-default's initial_usdt
      let replaced = false;
      const updated = paperContent.replace(
        /(\s+initial_usdt:\s*)(\d+)/,
        (match, prefix, _val) => {
          if (!replaced) {
            replaced = true;
            return `${prefix}${newVal}`;
          }
          return match;
        }
      );
      fs.writeFileSync(paperYamlPath, updated);
      console.log(ok(`initial_usdt updated to ${newVal}`));
    }
  }

  // ── Step 5: Verify API connectivity ───────────────────────────
  console.log(step(5, "API Connectivity Verification"));
  const testnetKeyPath = path.join(SECRETS_DIR, "binance-testnet.json");
  if (fs.existsSync(testnetKeyPath)) {
    try {
      const { BinanceClient } = await import("../exchange/binance-client.js");
      const client = new BinanceClient(testnetKeyPath, true, "spot");
      const balance = await client.getUsdtBalance();
      console.log(ok(`Spot Testnet connected, USDT balance = $${balance.toFixed(2)}`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(warn(`Spot Testnet connection failed: ${msg}`));
      console.log(info("Please check the API Key in .secrets/binance-testnet.json"));
    }
  }

  const futuresKeyPath = path.join(SECRETS_DIR, "binance-futures-testnet.json");
  if (fs.existsSync(futuresKeyPath)) {
    try {
      const { BinanceClient } = await import("../exchange/binance-client.js");
      const client = new BinanceClient(futuresKeyPath, true, "futures");
      const balance = await client.getUsdtBalance();
      console.log(ok(`Futures Testnet connected, USDT balance = $${balance.toFixed(2)}`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(warn(`Futures Testnet connection failed: ${msg}`));
    }
  }

  // ── Step 6: Cron sync ─────────────────────────────────────────
  console.log(step(6, "Cron Scheduled Tasks"));
  const syncCron = await confirm("Sync cron scheduled tasks (daily analysis + health check, etc.)?");
  if (syncCron) {
    try {
      execSync("npm run cron:sync", { cwd: ROOT, stdio: "inherit" });
      console.log(ok("Cron tasks synced"));
    } catch (e) {
      console.log(warn("Cron sync failed, you can manually run npm run cron:sync later"));
    }
  }

  // ── Done ──────────────────────────────────────────────────────
  console.log(`
${C.bold}${C.green}╔══════════════════════════════════════════════════════╗
║                  Setup Complete! 🎉                  ║
╚══════════════════════════════════════════════════════╝${C.reset}

${C.bold}Next Steps:${C.reset}

  ${C.cyan}# Start live monitoring (testnet mode)${C.reset}
  npm run live

  ${C.cyan}# View paper account status${C.reset}
  npm run paper:status

  ${C.cyan}# Single signal scan (no trading)${C.reset}
  npm run monitor

  ${C.cyan}# Backtest strategy${C.reset}
  npm run backtest

  ${C.cyan}# Diagnose environment issues${C.reset}
  npm run doctor

${C.yellow}📖 Full documentation: README.md${C.reset}
${C.gray}💬 OpenClaw Community: https://discord.com/invite/clawd${C.reset}
`);

  rl.close();
}

// ─── Helper: Configure a single secret file ─────────────────────
async function setupSecretFile(
  filename: string,
  label: string,
  hostname: string
): Promise<void> {
  const filePath = path.join(SECRETS_DIR, filename);

  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const hasReal = existing.apiKey && !existing.apiKey.includes("your_");
    if (hasReal) {
      console.log(ok(`${label} Key already exists (${existing.apiKey.slice(0, 8)}...), skipping`));
      return;
    }
  }

  console.log(`\n${C.bold}Configure ${label}${C.reset}`);
  console.log(info(`Apply at: https://${hostname}/`));

  const apiKey = (await ask("  API Key: ")).trim();
  const secretKey = (await ask("  Secret Key: ")).trim();

  if (!apiKey || !secretKey) {
    console.log(warn(`Skipping ${label} (no credentials entered)`));
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify({ apiKey, secretKey }, null, 2));
  console.log(ok(`Written to .secrets/${filename}`));
}

main().catch((e) => {
  console.error(err(`Setup error: ${e instanceof Error ? e.message : e}`));
  process.exit(1);
});
