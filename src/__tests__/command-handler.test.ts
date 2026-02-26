/**
 * command-handler.test.ts — Telegram 命令处理器单元测试（P7.3）
 *
 * 全部 mock 文件系统，不读写真实文件。
 * 22+ 测试用例。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { PaperAccount, PaperPosition } from "../paper/account.js";

// ─── mock paper/account.js ────────────────────────────────────────────────────
// 必须在 import command-handler 之前 mock
vi.mock("../paper/account.js", () => ({
  loadAccount: vi.fn(),
  saveAccount: vi.fn(),
  paperSell: vi.fn(),
  paperCoverShort: vi.fn(),
}));

import {
  parseCommand,
  handleCommand,
  handleHelp,
  handleBalance,
  handleProfit,
  handlePositions,
  handleStatus,
  handleForceSell,
  _setPriceFetcher,
  _resetPriceFetcher,
} from "../telegram/command-handler.js";

import {
  loadAccount,
  saveAccount,
  paperSell,
  paperCoverShort,
} from "../paper/account.js";

// ─── 类型化 mock ──────────────────────────────────────────────────────────────
const mockLoadAccount = vi.mocked(loadAccount);
const mockSaveAccount = vi.mocked(saveAccount);
const mockPaperSell = vi.mocked(paperSell);
const mockPaperCoverShort = vi.mocked(paperCoverShort);

// ─── 测试辅助：构建 mock 账户 ────────────────────────────────────────────────

function makeAccount(overrides: Partial<PaperAccount> = {}): PaperAccount {
  return {
    initialUsdt: 10000,
    usdt: 10000,
    positions: {},
    trades: [],
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    dailyLoss: { date: "2026-01-01", loss: 0 },
    ...overrides,
  };
}

function makeLongPosition(symbol: string, overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    symbol,
    side: "long" as const,
    quantity: 0.5,
    entryPrice: 50000,
    entryTime: Date.now() - 2 * 3_600_000, // 2 hours ago
    stopLoss: 47500,
    takeProfit: 57500,
    ...overrides,
  };
}

const MOCK_LOGS_DIR = "/mock/logs";

// ─── beforeEach：重置所有 mock ──────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetPriceFetcher();

  // 默认：readdirSync 返回空（无 scenario 文件）
  vi.spyOn(fs, "readdirSync").mockReturnValue([]);
  // 默认：readFileSync 抛出 ENOENT（文件不存在）
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("ENOENT: no such file");
  });
  // 默认：statSync 抛出错误
  vi.spyOn(fs, "statSync").mockImplementation(() => {
    throw new Error("ENOENT: no such file");
  });
  // writeFileSync 不实际写入
  vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
  vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetPriceFetcher();
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseCommand()", () => {
  // 1. 基本命令解析
  it("1. /profit → { command: '/profit', args: [] }", () => {
    const result = parseCommand("/profit");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/profit");
    expect(result?.args).toEqual([]);
    expect(result?.rawText).toBe("/profit");
  });

  // 2. 带单个参数
  it("2. /forcesell BTCUSDT → args: ['BTCUSDT']", () => {
    const result = parseCommand("/forcesell BTCUSDT");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/forcesell");
    expect(result?.args).toEqual(["BTCUSDT"]);
  });

  // 3. 带两个参数
  it("3. /forcesell BTCUSDT testnet-default → args 有两个", () => {
    const result = parseCommand("/forcesell BTCUSDT testnet-default");
    expect(result).not.toBeNull();
    expect(result?.args).toHaveLength(2);
    expect(result?.args[0]).toBe("BTCUSDT");
    expect(result?.args[1]).toBe("testnet-default");
  });

  // 4. 非命令文本
  it("4. 'hello' → null（不是命令）", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  // 5. 空字符串
  it("5. '' → null", () => {
    expect(parseCommand("")).toBeNull();
  });

  // 6. 不支持的命令
  it("6. '/unknown' → null（不在支持列表）", () => {
    expect(parseCommand("/unknown")).toBeNull();
  });

  // 21. 命令名大小写不敏感
  it("21. '/PROFIT' 等同于 '/profit'", () => {
    const result = parseCommand("/PROFIT");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/profit");
  });

  it("'/Forcesell BTCUSDT' → command='/forcesell'", () => {
    const result = parseCommand("/Forcesell BTCUSDT");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/forcesell");
    expect(result?.args[0]).toBe("BTCUSDT");
  });

  // 其他命令
  it("/positions 解析正常", () => {
    const result = parseCommand("/positions");
    expect(result?.command).toBe("/positions");
    expect(result?.args).toEqual([]);
  });

  it("/balance 解析正常", () => {
    const result = parseCommand("/balance");
    expect(result?.command).toBe("/balance");
  });

  it("/status 解析正常", () => {
    const result = parseCommand("/status");
    expect(result?.command).toBe("/status");
  });

  it("/help 解析正常", () => {
    const result = parseCommand("/help");
    expect(result?.command).toBe("/help");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleHelp
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleHelp()", () => {
  // 7. /help 包含所有命令名称
  it("7. 包含所有命令名称", () => {
    const result = handleHelp();
    expect(result).toContain("/profit");
    expect(result).toContain("/positions");
    expect(result).toContain("/balance");
    expect(result).toContain("/status");
    expect(result).toContain("/forcesell");
    expect(result).toContain("/help");
  });

  // 22. 响应文本包含 Telegram Markdown 格式
  it("22. 包含 Markdown *加粗* 格式", () => {
    const result = handleHelp();
    expect(result).toMatch(/\*[^*]+\*/); // *加粗文本*
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleProfit
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleProfit()", () => {
  // 8. 有持仓时显示盈亏数字
  it("8. 有持仓/交易时显示盈亏数字", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      initialUsdt: 10000,
      usdt: 9500,
      trades: [
        {
          id: "T001",
          symbol: "BTCUSDT",
          side: "sell",
          quantity: 0.1,
          price: 50500,
          usdtAmount: 5050,
          fee: 5.05,
          slippage: 2.5,
          timestamp: Date.now(),
          reason: "tp",
          pnl: 50,
          pnlPercent: 0.01,
        },
      ],
      positions: {
        ETHUSDT: makeLongPosition("ETHUSDT", { entryPrice: 3000, quantity: 1 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toContain("testnet-default");
    expect(result).toMatch(/\$\d+/); // 包含数字金额
  });

  // 9. 无账户文件时显示"暂无数据"
  it("9. 无 scenario 文件时显示暂无数据", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toContain("暂无数据");
  });

  it("包含收益汇总标题（Markdown 格式）", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-spot.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ initialUsdt: 10000, usdt: 10500 }));

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toContain("*收益汇总*");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handlePositions
// ═══════════════════════════════════════════════════════════════════════════════

describe("handlePositions()", () => {
  // 10. 有持仓时包含 symbol 名称
  it("10. 有持仓时包含 symbol 名称", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      positions: {
        BTCUSDT: makeLongPosition("BTCUSDT", { entryPrice: 67500 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("BTCUSDT");
  });

  // 11. 无持仓时显示"当前无持仓"
  it("11. 无持仓时显示当前无持仓", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("当前无持仓");
  });

  it("无 scenario 文件时也显示无持仓", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("当前无持仓");
  });

  it("持仓信息包含入场价", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-spot.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      positions: {
        ETHUSDT: makeLongPosition("ETHUSDT", { entryPrice: 3456.78 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("ETHUSDT");
    expect(result).toContain("3456");
  });

  it("多个 scenario 的持仓都显示", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "paper-spot.json",
      "paper-futures.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    mockLoadAccount
      .mockReturnValueOnce(
        makeAccount({
          positions: { BTCUSDT: makeLongPosition("BTCUSDT") },
        })
      )
      .mockReturnValueOnce(
        makeAccount({
          positions: { ETHUSDT: makeLongPosition("ETHUSDT") },
        })
      );

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("BTCUSDT");
    expect(result).toContain("ETHUSDT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleBalance
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleBalance()", () => {
  // 12. 显示 USDT 余额数字
  it("12. 显示 USDT 余额数字", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ usdt: 9876.54 }));

    const result = await handleBalance(MOCK_LOGS_DIR);
    expect(result).toContain("9876.54");
    expect(result).toContain("testnet-default");
  });

  it("无 scenario 时显示暂无数据", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleBalance(MOCK_LOGS_DIR);
    expect(result).toContain("暂无数据");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleStatus
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleStatus()", () => {
  // 13. 包含 signal-notify-dedup 相关信息
  it("13. 包含去重状态（signal-notify-dedup）", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const dedupData = {
      "BTCUSDT:buy": Date.now() - 30_000,
      "ETHUSDT:buy": Date.now() - 60_000,
    };
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).includes("signal-notify-dedup")) {
        return JSON.stringify(dedupData);
      }
      throw new Error("ENOENT");
    });

    const result = await handleStatus(MOCK_LOGS_DIR);
    // 包含 "signal-notify-dedup" 或 "去重" 相关内容
    expect(result).toMatch(/signal-notify-dedup|去重/);
  });

  it("signal-notify-dedup 文件不存在时显示无数据", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    // readFileSync 已在 beforeEach 中被 mock 为抛出错误

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toContain("无数据");
  });

  it("包含 scenario 数量信息", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "paper-spot.json",
      "paper-futures.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toContain("Scenario");
    expect(result).toContain("2");
  });

  it("live-monitor 日志存在时显示运行状态", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: Date.now() - 60_000, // 1 minute ago
    } as ReturnType<typeof fs.statSync>);

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toContain("live-monitor");
  });

  it("包含系统状态标题（Markdown 格式）", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toMatch(/\*[^*]+\*/); // *加粗文本*
    expect(result).toContain("*系统状态*");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleForceSell
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleForceSell()", () => {
  // 14. 缺少 symbol → 返回错误提示
  it("14. 缺少 symbol → 返回错误提示", async () => {
    const result = await handleForceSell([], MOCK_LOGS_DIR);
    expect(result).toContain("❌");
    expect(result).toContain("forcesell");
  });

  // 15. symbol 无持仓 → 返回"未找到持仓"
  it("15. symbol 无持仓 → 返回未找到持仓", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));

    const result = await handleForceSell(["BTCUSDT"], MOCK_LOGS_DIR);
    expect(result).toContain("❌");
    expect(result).toContain("未找到持仓");
  });

  // 16. 正常平仓 → 返回成功信息
  it("16. 正常平仓 → 返回成功信息", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      usdt: 5000,
      positions: {
        BTCUSDT: makeLongPosition("BTCUSDT", { entryPrice: 50000 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);

    // Mock price fetcher to return 51000
    _setPriceFetcher(async (_symbol: string) => 51000);

    // Mock paperSell to return a trade
    mockPaperSell.mockReturnValue({
      id: "SELL001",
      symbol: "BTCUSDT",
      side: "sell",
      quantity: 0.5,
      price: 51000,
      usdtAmount: 25500,
      fee: 25.5,
      slippage: 12.75,
      timestamp: Date.now(),
      reason: "telegram_forcesell",
      pnl: 500,
      pnlPercent: 0.02,
    });

    const result = await handleForceSell(["BTCUSDT"], MOCK_LOGS_DIR);
    expect(result).toContain("✅");
    expect(result).toContain("强制平仓成功");
    expect(mockSaveAccount).toHaveBeenCalledOnce();
  });

  it("指定 scenarioId 平仓正常工作", async () => {
    const account = makeAccount({
      positions: {
        ETHUSDT: makeLongPosition("ETHUSDT", { entryPrice: 3000 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);

    _setPriceFetcher(async (_s: string) => 3100);
    mockPaperSell.mockReturnValue({
      id: "SELL002",
      symbol: "ETHUSDT",
      side: "sell",
      quantity: 0.5,
      price: 3100,
      usdtAmount: 1550,
      fee: 1.55,
      slippage: 0.775,
      timestamp: Date.now(),
      reason: "telegram_forcesell",
      pnl: 50,
      pnlPercent: 0.033,
    });

    const result = await handleForceSell(
      ["ETHUSDT", "testnet-default"],
      MOCK_LOGS_DIR
    );
    expect(result).toContain("✅");
  });

  it("paperSell 返回 null 时报平仓失败", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      positions: {
        BTCUSDT: makeLongPosition("BTCUSDT"),
      },
    });
    mockLoadAccount.mockReturnValue(account);
    _setPriceFetcher(async (_s: string) => 50000);
    mockPaperSell.mockReturnValue(null);

    const result = await handleForceSell(["BTCUSDT"], MOCK_LOGS_DIR);
    expect(result).toContain("❌");
    expect(result).toContain("平仓失败");
  });

  it("价格获取失败时使用入场价作为备用", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      positions: {
        BTCUSDT: makeLongPosition("BTCUSDT", { entryPrice: 50000 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);
    _setPriceFetcher(async (_s: string) => null); // 价格获取失败

    mockPaperSell.mockReturnValue({
      id: "SELL003",
      symbol: "BTCUSDT",
      side: "sell",
      quantity: 0.5,
      price: 50000,
      usdtAmount: 25000,
      fee: 25,
      slippage: 12.5,
      timestamp: Date.now(),
      reason: "telegram_forcesell",
      pnl: 0,
      pnlPercent: 0,
    });

    const result = await handleForceSell(["BTCUSDT"], MOCK_LOGS_DIR);
    expect(result).toContain("✅");
    expect(result).toContain("入场价");
  });

  it("空头持仓使用 paperCoverShort 平仓", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const shortPosition: PaperPosition = {
      symbol: "BTCUSDT",
      side: "short",
      quantity: 0.5,
      entryPrice: 50000,
      entryTime: Date.now() - 3_600_000,
      stopLoss: 52500,
      takeProfit: 45000,
      marginUsdt: 25000,
    };

    const account = makeAccount({
      positions: { BTCUSDT: shortPosition },
    });
    mockLoadAccount.mockReturnValue(account);
    _setPriceFetcher(async (_s: string) => 48000);

    mockPaperCoverShort.mockReturnValue({
      id: "COVER001",
      symbol: "BTCUSDT",
      side: "cover",
      quantity: 0.5,
      price: 48000,
      usdtAmount: 26000,
      fee: 24,
      slippage: 12,
      timestamp: Date.now(),
      reason: "telegram_forcesell",
      pnl: 1000,
      pnlPercent: 0.04,
    });

    const result = await handleForceSell(["BTCUSDT"], MOCK_LOGS_DIR);
    expect(result).toContain("✅");
    expect(mockPaperCoverShort).toHaveBeenCalledOnce();
    expect(mockPaperSell).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleCommand — 集成分发测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("handleCommand() — 命令分发集成", () => {
  beforeEach(() => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
  });

  // 17. /profit → 调用 handleProfit（集成）
  it("17. /profit 命令返回收益汇总", async () => {
    const cmd = parseCommand("/profit");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("收益汇总");
  });

  // 18. /positions → 调用 handlePositions
  it("18. /positions 命令返回持仓信息", async () => {
    const cmd = parseCommand("/positions");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("持仓");
  });

  // 19. /balance → 调用 handleBalance
  it("19. /balance 命令返回余额信息", async () => {
    const cmd = parseCommand("/balance");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("余额");
  });

  // 20. /forcesell BTCUSDT → 调用 handleForceSell
  it("20. /forcesell 命令调用 forcesell 逻辑", async () => {
    // 无持仓时应返回"未找到持仓"（proof that handleForceSell was called）
    const cmd = parseCommand("/forcesell BTCUSDT");
    expect(cmd).not.toBeNull();
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("未找到持仓");
  });

  it("/help 返回帮助信息", async () => {
    const cmd = parseCommand("/help");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("/profit");
    expect(result).toContain("/positions");
  });

  it("/status 返回系统状态", async () => {
    const cmd = parseCommand("/status");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("系统状态");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 额外边界测试
// ═══════════════════════════════════════════════════════════════════════════════

describe("边界与格式测试", () => {
  it("forcesell symbol 自动转大写", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));

    // 小写 btcusdt → 应与 BTCUSDT 持仓匹配（无持仓，检查错误信息含大写 symbol）
    const result = await handleForceSell(["btcusdt"], MOCK_LOGS_DIR);
    expect(result).toContain("BTCUSDT");
  });

  it("profit 输出包含 Markdown 格式（*加粗*）", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-spot.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount());

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toMatch(/\*[^*]+\*/);
  });

  it("readdirSync 抛出异常时 listScenarios 返回空", async () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const result = await handleBalance(MOCK_LOGS_DIR);
    expect(result).toContain("暂无数据");
  });
});
