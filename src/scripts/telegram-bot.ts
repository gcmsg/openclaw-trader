/**
 * telegram-bot.ts — Telegram 命令接收器（P7.3）
 *
 * 两种运行模式：
 *
 * 1. 命令行工具（单次执行）：
 *    npm run cmd -- "/profit"
 *    直接处理命令并打印结果，方便手动测试。
 *
 * 2. 文件轮询模式（与 live-monitor 集成）：
 *    在 logs/pending-commands.json 中写入命令，
 *    此脚本读取并清空后执行，响应写入 logs/command-responses.json。
 *
 * 注意：如果有真实的 Telegram Bot Token（TELEGRAM_BOT_TOKEN 环境变量），
 * 可扩展为长轮询模式（getUpdates）。
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
// 接口定义
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
// 核心处理逻辑
// ─────────────────────────────────────────────────────

async function processCommandText(text: string): Promise<string> {
  const cmd = parseCommand(text);
  if (!cmd) {
    return `❓ 无效命令：\`${text}\`\n请发送 /help 查看命令列表。`;
  }
  return handleCommand(cmd);
}

/** 处理 pending-commands.json 中的命令队列 */
async function processPendingCommands(): Promise<number> {
  let commands: PendingCommand[];
  try {
    const raw = fs.readFileSync(PENDING_COMMANDS_FILE, "utf-8");
    commands = JSON.parse(raw) as PendingCommand[];
  } catch {
    return 0; // 文件不存在或为空，正常情况
  }

  if (!Array.isArray(commands) || commands.length === 0) return 0;

  // 立即清空命令队列（防止重复处理）
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

  // 追加响应记录
  let existing: CommandResponse[] = [];
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

/** 添加一条命令到 pending 队列（供外部调用） */
export function enqueueCommand(text: string): void {
  let commands: PendingCommand[] = [];
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
// 入口：判断运行模式
// ─────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length > 0) {
  // 命令行工具模式：npm run cmd -- "/profit"
  const text = args.join(" ");
  console.log(`\n🤖 处理命令：${text}\n${"─".repeat(40)}`);
  const cmd = parseCommand(text);
  if (!cmd) {
    console.log(`❓ 无效命令：${text}\n请使用 /help 查看命令列表。`);
    process.exit(1);
  }
  handleCommand(cmd)
    .then((response) => {
      console.log(response);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("命令处理失败：", err);
      process.exit(1);
    });
} else {
  // 文件轮询模式：单次处理 pending-commands.json
  processPendingCommands()
    .then((count) => {
      if (count === 0) {
        console.log("[telegram-bot] 无待处理命令");
      } else {
        console.log(`[telegram-bot] 已处理 ${count} 条命令`);
      }
    })
    .catch((err: unknown) => {
      console.error("[telegram-bot] 错误：", err);
      process.exit(1);
    });
}
