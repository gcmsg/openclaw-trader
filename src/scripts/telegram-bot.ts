/**
 * telegram-bot.ts — Telegram Command Receiver (P7.3)
 *
 * Two operating modes:
 *
 * 1. CLI tool (single execution):
 *    npm run cmd -- "/profit"
 *    Processes command directly and prints result, convenient for manual testing.
 *
 * 2. File polling mode (integrated with live-monitor):
 *    Write commands to logs/pending-commands.json,
 *    this script reads and clears them, writes responses to logs/command-responses.json.
 *
 * Note: If a real Telegram Bot Token is available (TELEGRAM_BOT_TOKEN env var),
 * this can be extended to long-polling mode (getUpdates).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCommand, handleCommand } from "../telegram/command-handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, "../../logs");
const PENDING_COMMANDS_FILE = path.join(LOGS_DIR, "pending-commands.json");
const RESPONSES_FILE = path.join(LOGS_DIR, "command-responses.json");

// ─────────────────────────────────────────────────────
// Interface Definitions
// ─────────────────────────────────────────────────────

interface PendingCommand {
  id: string;
  text: string;
  timestamp: number;
}

interface CommandResponse {
  id: string;
  text: string;
  response: string;
  timestamp: number;
}

// ─────────────────────────────────────────────────────
// Core Processing Logic
// ─────────────────────────────────────────────────────

async function processCommandText(text: string): Promise<string> {
  const cmd = parseCommand(text);
  if (!cmd) {
    return `❓ Invalid command: \`${text}\`\nSend /help to see the command list.`;
  }
  return handleCommand(cmd);
}

/** Process command queue from pending-commands.json */
async function processPendingCommands(): Promise<number> {
  let commands: PendingCommand[];
  try {
    const raw = fs.readFileSync(PENDING_COMMANDS_FILE, "utf-8");
    commands = JSON.parse(raw) as PendingCommand[];
  } catch {
    return 0; // File doesn't exist or is empty, normal case
  }

  if (!Array.isArray(commands) || commands.length === 0) return 0;

  // Clear command queue immediately (prevent duplicate processing)
  fs.writeFileSync(PENDING_COMMANDS_FILE, "[]");

  const responses: CommandResponse[] = [];
  for (const cmd of commands) {
    const response = await processCommandText(cmd.text);
    responses.push({
      id: cmd.id,
      text: cmd.text,
      response,
      timestamp: Date.now(),
    });
    console.log(`[CMD] ${cmd.text}\n${response}\n`);
  }

  // Append response records
  let existing: CommandResponse[];
  try {
    existing = JSON.parse(
      fs.readFileSync(RESPONSES_FILE, "utf-8")
    ) as CommandResponse[];
  } catch {
    existing = [];
  }
  fs.writeFileSync(
    RESPONSES_FILE,
    JSON.stringify([...existing, ...responses].slice(-100), null, 2)
  );

  return responses.length;
}

/** Add a command to the pending queue (for external use) */
export function enqueueCommand(text: string): void {
  let commands: PendingCommand[];
  try {
    commands = JSON.parse(
      fs.readFileSync(PENDING_COMMANDS_FILE, "utf-8")
    ) as PendingCommand[];
  } catch {
    commands = [];
  }
  commands.push({
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    timestamp: Date.now(),
  });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(PENDING_COMMANDS_FILE, JSON.stringify(commands, null, 2));
}

// ─────────────────────────────────────────────────────
// Entry: determine operating mode
// ─────────────────────────────────────────────────────

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

const args = process.argv.slice(2);

if (args.length > 0) {
  // CLI tool mode: npm run cmd -- "/profit"
  const text = args.join(" ");
  console.log(`\n🤖 Processing command: ${text}\n${"─".repeat(40)}`);
  const cmd = parseCommand(text);
  if (!cmd) {
    console.log(`❓ Invalid command: ${text}\nUse /help to see the command list.`);
    process.exit(1);
  }
  handleCommand(cmd)
    .then((response) => {
      console.log(response);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("Command processing failed:", err);
      process.exit(1);
    });
} else {
  // File polling mode: process pending-commands.json once
  processPendingCommands()
    .then((count) => {
      if (count === 0) {
        console.log("[telegram-bot] No pending commands");
      } else {
        console.log(`[telegram-bot] Processed ${count} command(s)`);
      }
    })
    .catch((err: unknown) => {
      console.error("[telegram-bot] Error:", err);
      process.exit(1);
    });
}
