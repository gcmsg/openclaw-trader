/**
 * command-handler.test.ts — Telegram command handler unit tests (P7.3)
 *
 * All file system operations are mocked; no real file reads/writes.
 * 22+ test cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { PaperAccount, PaperPosition } from "../paper/account.js";

// -- mock paper/account.js -- (must be mocked before importing command-handler)
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

// -- Typed mocks --
const mockLoadAccount = vi.mocked(loadAccount);
const mockSaveAccount = vi.mocked(saveAccount);
const mockPaperSell = vi.mocked(paperSell);
const mockPaperCoverShort = vi.mocked(paperCoverShort);

// -- Test helper: build mock account --

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

// -- beforeEach: reset all mocks --

beforeEach(() => {
  vi.clearAllMocks();
  _resetPriceFetcher();

  // Default: readdirSync returns empty (no scenario files)
  vi.spyOn(fs, "readdirSync").mockReturnValue([]);
  // Default: readFileSync throws ENOENT (file does not exist)
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("ENOENT: no such file");
  });
  // Default: statSync throws error
  vi.spyOn(fs, "statSync").mockImplementation(() => {
    throw new Error("ENOENT: no such file");
  });
  // writeFileSync does not actually write
  vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
  vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetPriceFetcher();
});

// ===============================================
// parseCommand
// ===============================================

describe("parseCommand()", () => {
  // 1. Basic command parsing
  it("1. /profit -> { command: '/profit', args: [] }", () => {
    const result = parseCommand("/profit");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/profit");
    expect(result?.args).toEqual([]);
    expect(result?.rawText).toBe("/profit");
  });

  // 2. Single argument
  it("2. /forcesell BTCUSDT -> args: ['BTCUSDT']", () => {
    const result = parseCommand("/forcesell BTCUSDT");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/forcesell");
    expect(result?.args).toEqual(["BTCUSDT"]);
  });

  // 3. Two arguments
  it("3. /forcesell BTCUSDT testnet-default -> args has two elements", () => {
    const result = parseCommand("/forcesell BTCUSDT testnet-default");
    expect(result).not.toBeNull();
    expect(result?.args).toHaveLength(2);
    expect(result?.args[0]).toBe("BTCUSDT");
    expect(result?.args[1]).toBe("testnet-default");
  });

  // 4. Non-command text
  it("4. 'hello' -> null (not a command)", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  // 5. Empty string
  it("5. '' -> null", () => {
    expect(parseCommand("")).toBeNull();
  });

  // 6. Unsupported command
  it("6. '/unknown' -> null (not in supported list)", () => {
    expect(parseCommand("/unknown")).toBeNull();
  });

  // 21. Command name is case-insensitive
  it("21. '/PROFIT' is equivalent to '/profit'", () => {
    const result = parseCommand("/PROFIT");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/profit");
  });

  it("'/Forcesell BTCUSDT' -> command='/forcesell'", () => {
    const result = parseCommand("/Forcesell BTCUSDT");
    expect(result).not.toBeNull();
    expect(result?.command).toBe("/forcesell");
    expect(result?.args[0]).toBe("BTCUSDT");
  });

  // Other commands
  it("/positions parses correctly", () => {
    const result = parseCommand("/positions");
    expect(result?.command).toBe("/positions");
    expect(result?.args).toEqual([]);
  });

  it("/balance parses correctly", () => {
    const result = parseCommand("/balance");
    expect(result?.command).toBe("/balance");
  });

  it("/status parses correctly", () => {
    const result = parseCommand("/status");
    expect(result?.command).toBe("/status");
  });

  it("/help parses correctly", () => {
    const result = parseCommand("/help");
    expect(result?.command).toBe("/help");
  });
});

// ===============================================
// handleHelp
// ===============================================

describe("handleHelp()", () => {
  // 7. /help contains all command names
  it("7. contains all command names", () => {
    const result = handleHelp();
    expect(result).toContain("/profit");
    expect(result).toContain("/positions");
    expect(result).toContain("/balance");
    expect(result).toContain("/status");
    expect(result).toContain("/forcesell");
    expect(result).toContain("/help");
  });

  // 22. Response text contains Telegram Markdown formatting
  it("22. contains Markdown *bold* formatting", () => {
    const result = handleHelp();
    expect(result).toMatch(/\*[^*]+\*/); // *bold text*
  });
});

// ===============================================
// handleProfit
// ===============================================

describe("handleProfit()", () => {
  // 8. Shows profit/loss numbers when positions/trades exist
  it("8. shows profit/loss numbers with positions/trades", async () => {
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
    expect(result).toMatch(/\$\d+/); // contains monetary amount
  });

  // 9. Shows "no data" when no account files exist
  it("9. shows no data when no scenario files exist", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toContain("No data available");
  });

  it("contains profit summary title (Markdown format)", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-spot.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ initialUsdt: 10000, usdt: 10500 }));

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toContain("*Profit Summary*");
  });
});

// ===============================================
// handlePositions
// ===============================================

describe("handlePositions()", () => {
  // 10. Contains symbol name when positions exist
  it("10. contains symbol name when positions exist", async () => {
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

  // 11. Shows "no positions" when empty
  it("11. shows no positions when empty", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("No positions");
  });

  it("shows no positions when no scenario files exist", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handlePositions(MOCK_LOGS_DIR);
    expect(result).toContain("No positions");
  });

  it("position info includes entry price", async () => {
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

  it("positions from multiple scenarios are all displayed", async () => {
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

// ===============================================
// handleBalance
// ===============================================

describe("handleBalance()", () => {
  // 12. Shows USDT balance number
  it("12. shows USDT balance number", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ usdt: 9876.54 }));

    const result = await handleBalance(MOCK_LOGS_DIR);
    expect(result).toContain("9876.54");
    expect(result).toContain("testnet-default");
  });

  it("shows no data when no scenarios exist", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleBalance(MOCK_LOGS_DIR);
    expect(result).toContain("No data available");
  });
});

// ===============================================
// handleStatus
// ===============================================

describe("handleStatus()", () => {
  // 13. Contains signal-notify-dedup related info
  it("13. contains dedup state (signal-notify-dedup)", async () => {
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
    // Contains "signal-notify-dedup" or dedup related content
    expect(result).toMatch(/signal-notify-dedup|Signal Dedup/);
  });

  it("shows no data when signal-notify-dedup file does not exist", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    // readFileSync already mocked to throw in beforeEach

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toContain("No data");
  });

  it("contains scenario count information", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      "paper-spot.json",
      "paper-futures.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toContain("Scenario");
    expect(result).toContain("2");
  });

  it("shows running status when live-monitor log exists", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: Date.now() - 60_000, // 1 minute ago
    } as ReturnType<typeof fs.statSync>);

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toContain("live-monitor");
  });

  it("contains system status title (Markdown format)", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

    const result = await handleStatus(MOCK_LOGS_DIR);
    expect(result).toMatch(/\*[^*]+\*/); // *bold text*
    expect(result).toContain("*System Status*");
  });
});

// ===============================================
// handleForceSell
// ===============================================

describe("handleForceSell()", () => {
  // 14. Missing symbol -> returns error message
  it("14. missing symbol -> returns error message", async () => {
    const result = await handleForceSell([], MOCK_LOGS_DIR);
    expect(result).toContain("❌");
    expect(result).toContain("forcesell");
  });

  // 15. Symbol has no position -> returns "position not found"
  it("15. symbol has no position -> returns position not found", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));

    const result = await handleForceSell(["BTCUSDT"], MOCK_LOGS_DIR);
    expect(result).toContain("❌");
    expect(result).toContain("Position not found");
  });

  // 16. Normal close -> returns success message
  it("16. normal close -> returns success message", async () => {
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
    expect(result).toContain("Force Close Successful");
    expect(mockSaveAccount).toHaveBeenCalledOnce();
  });

  it("specifying scenarioId for close works correctly", async () => {
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

  it("paperSell returns null -> reports close failure", async () => {
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
    expect(result).toContain("Close position failed");
  });

  it("price fetch fails -> uses entry price as fallback", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);

    const account = makeAccount({
      positions: {
        BTCUSDT: makeLongPosition("BTCUSDT", { entryPrice: 50000 }),
      },
    });
    mockLoadAccount.mockReturnValue(account);
    _setPriceFetcher(async (_s: string) => null); // price fetch fails

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
    expect(result).toContain("Entry price");
  });

  it("short position uses paperCoverShort to close", async () => {
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

// ===============================================
// handleCommand — integration dispatch test
// ===============================================

describe("handleCommand() — command dispatch integration", () => {
  beforeEach(() => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
  });

  // 17. /profit -> calls handleProfit (integration)
  it("17. /profit command returns profit summary", async () => {
    const cmd = parseCommand("/profit");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("Profit Summary");
  });

  // 18. /positions -> calls handlePositions
  it("18. /positions command returns position info", async () => {
    const cmd = parseCommand("/positions");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("Positions");
  });

  // 19. /balance -> calls handleBalance
  it("19. /balance command returns balance info", async () => {
    const cmd = parseCommand("/balance");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("Balance");
  });

  // 20. /forcesell BTCUSDT -> calls handleForceSell
  it("20. /forcesell command calls forcesell logic", async () => {
    // No position -> should return "position not found" (proof that handleForceSell was called)
    const cmd = parseCommand("/forcesell BTCUSDT");
    expect(cmd).not.toBeNull();
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("Position not found");
  });

  it("/help returns help info", async () => {
    const cmd = parseCommand("/help");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("/profit");
    expect(result).toContain("/positions");
  });

  it("/status returns system status", async () => {
    const cmd = parseCommand("/status");
    expect(cmd).not.toBeNull();
    const result = await handleCommand(cmd!, MOCK_LOGS_DIR);
    expect(result).toContain("System Status");
  });
});

// ===============================================
// Additional boundary tests
// ===============================================

describe("Boundary and format tests", () => {
  it("forcesell symbol auto-uppercases", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-testnet-default.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount({ positions: {} }));

    // Lowercase btcusdt -> should match BTCUSDT position (no position, check error contains uppercase symbol)
    const result = await handleForceSell(["btcusdt"], MOCK_LOGS_DIR);
    expect(result).toContain("BTCUSDT");
  });

  it("profit output contains Markdown format (*bold*)", async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(["paper-spot.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    mockLoadAccount.mockReturnValue(makeAccount());

    const result = await handleProfit(MOCK_LOGS_DIR);
    expect(result).toMatch(/\*[^*]+\*/);
  });

  it("readdirSync throws exception -> listScenarios returns empty", async () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const result = await handleBalance(MOCK_LOGS_DIR);
    expect(result).toContain("No data available");
  });
});
