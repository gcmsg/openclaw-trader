/**
 * 空头账户层测试
 * 覆盖：paperOpenShort / paperCoverShort / calcTotalEquity / updateTrailingStop（空头方向）
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  type PaperAccount,
  type PaperPosition,
  paperBuy,
  paperOpenShort,
  paperCoverShort,
  calcTotalEquity,
  updateTrailingStop,
  getAccountSummary,
} from "../paper/account.js";

// ─── 辅助 ───────────────────────────────────────────

function makeAccount(usdt = 10_000): PaperAccount {
  return {
    initialUsdt: usdt,
    usdt,
    positions: {},
    trades: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyLoss: { date: "2026-01-01", loss: 0 },
  };
}

const BASE_OPTS = {
  feeRate: 0,           // 免手续费，方便验证数值
  slippagePercent: 0,   // 免滑点
  stopLossPercent: 5,
  takeProfitPercent: 15,
  positionRatio: 0.2,
};

// ─── paperOpenShort ──────────────────────────────────

describe("paperOpenShort", () => {
  let account: PaperAccount;
  beforeEach(() => { account = makeAccount(); });

  it("正常开空：锁定保证金，记录 trade(side=short)", () => {
    const trade = paperOpenShort(account, "BTCUSDT", 100, "ma_bearish", BASE_OPTS);
    expect(trade).not.toBeNull();
    expect(trade!.side).toBe("short");
    // 锁定保证金 = 10000 × 0.2 = 2000
    expect(account.usdt).toBeCloseTo(8000, 5);
    // 持仓方向
    const pos = account.positions["BTCUSDT"];
    expect(pos).toBeDefined();
    expect(pos!.side).toBe("short");
    expect(pos!.entryPrice).toBeCloseTo(100);
    expect(pos!.quantity).toBeCloseTo(20); // 2000 / 100
    expect(pos!.marginUsdt).toBeCloseTo(2000);
  });

  it("止损价高于入场价（空头止损方向相反）", () => {
    paperOpenShort(account, "BTCUSDT", 100, "test", BASE_OPTS);
    const pos = account.positions["BTCUSDT"]!;
    // 止损 = 100 × 1.05 = 105（价格上涨时亏损）
    expect(pos.stopLoss).toBeCloseTo(105);
    // 止盈 = 100 × 0.85 = 85（价格下跌时盈利）
    expect(pos.takeProfit).toBeCloseTo(85);
  });

  it("同一币种已有持仓时拒绝开空", () => {
    paperOpenShort(account, "BTCUSDT", 100, "test1", BASE_OPTS);
    const trade2 = paperOpenShort(account, "BTCUSDT", 100, "test2", BASE_OPTS);
    expect(trade2).toBeNull();
  });

  it("多头持仓存在时拒绝开空（同一币种）", () => {
    paperBuy(account, "BTCUSDT", 100, "buy", BASE_OPTS);
    const trade = paperOpenShort(account, "BTCUSDT", 100, "short", BASE_OPTS);
    expect(trade).toBeNull();
  });

  it("保证金不足时返回 null", () => {
    const broke = makeAccount(5); // 只有 5 USDT
    const trade = paperOpenShort(broke, "BTCUSDT", 100, "test", {
      ...BASE_OPTS,
      minOrderUsdt: 10,
    });
    expect(trade).toBeNull();
  });

  it("有手续费时保证金正确扣除", () => {
    const opts = { ...BASE_OPTS, feeRate: 0.001 };
    paperOpenShort(account, "BTCUSDT", 100, "test", opts);
    // marginToLock = 2000, fee = 2, actualMargin = 1998, qty = 1998/100 = 19.98
    const pos = account.positions["BTCUSDT"]!;
    expect(pos.marginUsdt).toBeCloseTo(1998);
    expect(pos.quantity).toBeCloseTo(19.98);
    expect(account.usdt).toBeCloseTo(8000); // 扣除的是 marginToLock=2000
  });

  it("有滑点时成交价低于市价（做空方不利）", () => {
    const opts = { ...BASE_OPTS, slippagePercent: 0.1 };
    paperOpenShort(account, "BTCUSDT", 100, "test", opts);
    const pos = account.positions["BTCUSDT"]!;
    // 滑点 0.1%，市价 100 → execPrice = 99.9
    expect(pos.entryPrice).toBeCloseTo(99.9);
  });
});

// ─── paperCoverShort ─────────────────────────────────

describe("paperCoverShort", () => {
  let account: PaperAccount;
  beforeEach(() => {
    account = makeAccount();
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    // 开空后：usdt=8000, pos.qty=20, pos.margin=2000
  });

  it("价格下跌：正确计算盈利并归还保证金", () => {
    // 价格从 100 跌到 80（跌 20%）
    const trade = paperCoverShort(account, "BTCUSDT", 80, "cover", BASE_OPTS);
    expect(trade).not.toBeNull();
    expect(trade!.side).toBe("cover");
    // pnl = (100-80) × 20 = 400
    expect(trade!.pnl).toBeCloseTo(400);
    // pnlPercent = 400/2000 = 0.2
    expect(trade!.pnlPercent).toBeCloseTo(0.2);
    // 归还：8000 + 2000 + 400 = 10400
    expect(account.usdt).toBeCloseTo(10400);
    // 持仓清除
    expect(account.positions["BTCUSDT"]).toBeUndefined();
  });

  it("价格上涨：正确计算亏损并扣除保证金", () => {
    // 价格从 100 涨到 110（涨 10%）
    const trade = paperCoverShort(account, "BTCUSDT", 110, "stop_loss", BASE_OPTS);
    expect(trade).not.toBeNull();
    // pnl = (100-110) × 20 = -200
    expect(trade!.pnl).toBeCloseTo(-200);
    // 归还：2000 - 200 = 1800 → usdt = 8000+1800 = 9800
    expect(account.usdt).toBeCloseTo(9800);
    // 亏损记录到 dailyLoss
    expect(account.dailyLoss.loss).toBeCloseTo(200);
  });

  it("无空头持仓时返回 null", () => {
    const trade = paperCoverShort(account, "ETHUSDT", 100, "test", BASE_OPTS);
    expect(trade).toBeNull();
  });

  it("尝试平多头持仓（side=long）时返回 null", () => {
    paperBuy(account, "ETHUSDT", 100, "buy", BASE_OPTS);
    const trade = paperCoverShort(account, "ETHUSDT", 100, "test", BASE_OPTS);
    expect(trade).toBeNull();
  });

  it("极端亏损（价格翻倍）：最多归零保证金，不产生负余额", () => {
    // 价格从 100 涨到 200（亏损 = 20 × 100 = 2000 = 整个保证金）
    paperCoverShort(account, "BTCUSDT", 200, "liquidate", BASE_OPTS);
    // usdt 不应为负数
    expect(account.usdt).toBeGreaterThanOrEqual(8000); // 至少 8000（归零保证金）
  });

  it("有手续费时 pnl 正确", () => {
    const opts = { ...BASE_OPTS, feeRate: 0.001 };
    paperOpenShort(account, "ETHUSDT", 100, "open", opts);
    // ETHUSDT：equity=10000, margin=2000-2=1998, qty=19.98
    // 平仓价 80：gross=19.98×80=1598.4, fee=1.598, pnl=(100-80)×19.98-1.598=399.6-1.598=398.0
    const pos = account.positions["ETHUSDT"]!;
    const trade = paperCoverShort(account, "ETHUSDT", 80, "cover", opts);
    expect(trade).not.toBeNull();
    const expectedPnl = (100 - 80) * pos.quantity - 80 * pos.quantity * 0.001;
    expect(trade!.pnl).toBeCloseTo(expectedPnl, 2);
  });
});

// ─── calcTotalEquity (空头) ──────────────────────────

describe("calcTotalEquity with short positions", () => {
  it("空头持仓浮盈时，总资产增加", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    // usdt=8000, pos.margin=2000, qty=20
    // 价格跌到 80：unrealizedPnl = (100-80)×20 = 400
    const equity = calcTotalEquity(account, { BTCUSDT: 80 });
    expect(equity).toBeCloseTo(10400); // 8000 + 2000 + 400
  });

  it("空头持仓浮亏时，总资产减少", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    // 价格涨到 110：unrealizedPnl = (100-110)×20 = -200
    const equity = calcTotalEquity(account, { BTCUSDT: 110 });
    expect(equity).toBeCloseTo(9800); // 8000 + 2000 - 200
  });

  it("多头+空头同时持有，总资产正确", () => {
    const account = makeAccount(10_000);
    // 开多 ETH：equity=10000，usdt变8000，eth.qty=20
    paperBuy(account, "ETHUSDT", 100, "buy", BASE_OPTS);
    // 开空 BTC：calcTotalEquity 只传入 { BTCUSDT:100 }，ETHUSDT 无价格被跳过
    //   → equity=8000（usdt only），marginToLock=1600，qty=16，usdt=6400
    paperOpenShort(account, "BTCUSDT", 100, "short", BASE_OPTS);

    // ETH涨到120（多头盈利），BTC涨到110（空头亏损）
    const equity = calcTotalEquity(account, { ETHUSDT: 120, BTCUSDT: 110 });
    // usdt=6400, ETH: 20×120=2400, BTC short: 1600+(100-110)×16=1440
    expect(equity).toBeCloseTo(10240);
  });

  it("无价格数据时跳过该持仓", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    const equity = calcTotalEquity(account, {}); // 无 BTCUSDT 价格
    expect(equity).toBeCloseTo(8000); // 只有 usdt
  });
});

// ─── updateTrailingStop (空头) ──────────────────────

describe("updateTrailingStop for short positions", () => {
  function makeShortPos(entryPrice: number): PaperPosition {
    return {
      symbol: "BTCUSDT",
      side: "short",
      quantity: 10,
      entryPrice,
      entryTime: Date.now(),
      stopLoss: entryPrice * 1.05,
      takeProfit: entryPrice * 0.85,
      marginUsdt: entryPrice * 10,
    };
  }

  it("未达激活阈值时不激活", () => {
    const pos = makeShortPos(100);
    // 价格只跌了 1%，激活需要 5%
    const shouldExit = updateTrailingStop(pos, 99, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(false);
    expect(pos.trailingStop?.active).toBe(false);
  });

  it("达到激活阈值后激活追踪止损", () => {
    const pos = makeShortPos(100);
    updateTrailingStop(pos, 94, { activationPercent: 5, callbackPercent: 2 });
    // 跌到 94，跌幅 6% ≥ 5%
    expect(pos.trailingStop?.active).toBe(true);
    expect(pos.trailingStop?.lowestPrice).toBeCloseTo(94);
  });

  it("价格继续下跌：更新最低价，不触发", () => {
    const pos = makeShortPos(100);
    updateTrailingStop(pos, 94, { activationPercent: 5, callbackPercent: 2 });
    const shouldExit = updateTrailingStop(pos, 90, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(false);
    expect(pos.trailingStop?.lowestPrice).toBeCloseTo(90);
  });

  it("价格从最低点反弹超过回调幅度：触发平仓", () => {
    const pos = makeShortPos(100);
    // 跌到 90（激活）
    updateTrailingStop(pos, 90, { activationPercent: 5, callbackPercent: 2 });
    // stopPrice = 90 × 1.02 = 91.8
    // 价格反弹到 92，超过 91.8
    const shouldExit = updateTrailingStop(pos, 92, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(true);
  });

  it("价格反弹未超过回调幅度：不触发", () => {
    const pos = makeShortPos(100);
    updateTrailingStop(pos, 90, { activationPercent: 5, callbackPercent: 2 });
    // stopPrice = 90 × 1.02 = 91.8，反弹到 91（未超）
    const shouldExit = updateTrailingStop(pos, 91, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(false);
  });

  it("多头追踪止损逻辑不受影响", () => {
    const pos: PaperPosition = {
      symbol: "BTCUSDT",
      side: "long",
      quantity: 10,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 95,
      takeProfit: 115,
    };
    // 涨到 110（激活），再跌到 107.8（触发）
    updateTrailingStop(pos, 110, { activationPercent: 5, callbackPercent: 2 });
    // stopPrice = 110 × 0.98 = 107.8
    const shouldExit = updateTrailingStop(pos, 107, { activationPercent: 5, callbackPercent: 2 });
    expect(shouldExit).toBe(true);
  });
});

// ─── getAccountSummary (空头) ────────────────────────

describe("getAccountSummary with short positions", () => {
  it("空头浮盈时 unrealizedPnl 为正", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    const summary = getAccountSummary(account, { BTCUSDT: 80 });
    const pos = summary.positions[0]!;
    expect(pos.side).toBe("short");
    expect(pos.unrealizedPnl).toBeCloseTo(400); // (100-80)×20
    expect(pos.unrealizedPnlPercent).toBeCloseTo(0.2);
    expect(summary.totalEquity).toBeCloseTo(10400);
  });

  it("空头浮亏时 unrealizedPnl 为负", () => {
    const account = makeAccount(10_000);
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    const summary = getAccountSummary(account, { BTCUSDT: 120 });
    const pos = summary.positions[0]!;
    expect(pos.unrealizedPnl).toBeCloseTo(-400); // (100-120)×20
    expect(summary.totalEquity).toBeCloseTo(9600);
  });

  it("cover 交易计入胜率计算（平空=已平仓）", () => {
    const account = makeAccount(10_000);
    // 开空盈利
    paperOpenShort(account, "BTCUSDT", 100, "open", BASE_OPTS);
    paperCoverShort(account, "BTCUSDT", 80, "cover", BASE_OPTS);
    // 开空亏损
    paperOpenShort(account, "BTCUSDT", 100, "open2", BASE_OPTS);
    paperCoverShort(account, "BTCUSDT", 120, "cover2", BASE_OPTS);
    const summary = getAccountSummary(account, {});
    // 1 赢 1 输，胜率 50%
    expect(summary.winRate).toBeCloseTo(0.5);
  });

  it("多空混合持仓同时正确展示", () => {
    const account = makeAccount(10_000);
    paperBuy(account, "ETHUSDT", 100, "buy", BASE_OPTS);
    paperOpenShort(account, "BTCUSDT", 100, "short", BASE_OPTS);
    const summary = getAccountSummary(account, { ETHUSDT: 110, BTCUSDT: 90 });
    const eth = summary.positions.find((p) => p.symbol === "ETHUSDT")!;
    const btc = summary.positions.find((p) => p.symbol === "BTCUSDT")!;
    expect(eth.side).toBe("long");
    expect(eth.unrealizedPnl).toBeGreaterThan(0); // ETH 涨了
    expect(btc.side).toBe("short");
    expect(btc.unrealizedPnl).toBeGreaterThan(0); // BTC 跌了，空头盈利
  });
});

// ─── 向后兼容（旧持仓无 side 字段） ────────────────

describe("backward compatibility", () => {
  it("PaperPosition 无 side 字段时按多头处理", () => {
    const account = makeAccount(10_000);
    // 手动创建没有 side 字段的旧格式持仓
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 10,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 95,
      takeProfit: 115,
    };
    // equity 应按多头计算：10 × 120 = 1200
    const equity = calcTotalEquity(account, { BTCUSDT: 120 });
    expect(equity).toBeCloseTo(10_000 - 0 + 10 * 120); // usdt 未变，position 贡献 1200
  });

  it("getAccountSummary 旧持仓 side 显示为 long", () => {
    const account = makeAccount(10_000);
    account.positions["BTCUSDT"] = {
      symbol: "BTCUSDT",
      quantity: 10,
      entryPrice: 100,
      entryTime: Date.now(),
      stopLoss: 95,
      takeProfit: 115,
    };
    const summary = getAccountSummary(account, { BTCUSDT: 100 });
    expect(summary.positions[0]!.side).toBe("long");
  });
});
