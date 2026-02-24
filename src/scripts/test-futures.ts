/**
 * Futures Testnet 端到端测试
 * 1. 连通性（ping / 余额 / 行情）
 * 2. 开空 → 查询确认 → 平空
 * 3. 验证余额变化（手续费）
 */
import { BinanceClient } from "../exchange/binance-client.js";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const client = new BinanceClient(".secrets/binance-futures-testnet.json", true, "futures");

  console.log("=== Futures Testnet 端到端测试 ===\n");

  // ── 1. 连通性 ──────────────────────────────────────
  const ok = await client.ping();
  console.log(`[1] ping: ${ok ? "✅ 正常" : "❌ 失败"}`);

  const bal = await client.getUsdtBalance();
  console.log(`[2] USDT 余额: $${bal.toFixed(4)}`);

  const btcPrice = await client.getPrice("BTCUSDT");
  console.log(`[3] BTCUSDT 价格: $${btcPrice.toFixed(2)}`);

  // ── 2. 清理残留仓位（前次测试可能遗留）──────────────
  console.log("\n[4] 清理残留空头仓位（如有）...");
  try {
    const cleanCover = await client.marketBuyByQty("BTCUSDT", 0.002);
    console.log(`    清理成功: orderId=${cleanCover.orderId}, status=${cleanCover.status}`);
    await sleep(2000);
    const balAfterClean = await client.getUsdtBalance();
    console.log(`    清理后余额: $${balAfterClean.toFixed(4)}`);
  } catch (e: unknown) {
    // 可能没有仓位，忽略错误
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ReduceOnly") || msg.includes("reduce only") || msg.includes("-2022")) {
      console.log("    无残留仓位，跳过");
    } else {
      console.log(`    清理报错（忽略）: ${msg.slice(0, 80)}`);
    }
  }

  const balBefore = await client.getUsdtBalance();
  console.log(`\n[5] 测试起始余额: $${balBefore.toFixed(4)}`);

  // ── 3. 开空 ────────────────────────────────────────
  const testQty = 0.002; // 0.002 BTC ≈ $127，高于最小名义价值 $100
  console.log(`\n[6] 开空 ${testQty} BTC (≈$${(testQty * btcPrice).toFixed(0)})...`);

  let shortOrderId: number | null = null;
  try {
    const shortOrder = await client.marketSell("BTCUSDT", testQty);
    shortOrderId = shortOrder.orderId;
    console.log(`    ✅ 开空提交: orderId=${shortOrder.orderId}, status=${shortOrder.status}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    ❌ 开空失败: ${msg}`);
    process.exit(1);
  }

  // 等待 Futures testnet 异步执行
  await sleep(2000);

  // 查询最终状态
  if (shortOrderId) {
    try {
      const confirmed = await client.getOrder("BTCUSDT", shortOrderId);
      console.log(`    确认状态: ${confirmed.status}, execQty=${confirmed.executedQty}, avgPrice=${confirmed.price}`);
    } catch (e: unknown) {
      console.log(`    查询状态失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  const balAfterShort = await client.getUsdtBalance();
  const marginLocked = balBefore - balAfterShort;
  console.log(`    余额变化: $${balBefore.toFixed(4)} → $${balAfterShort.toFixed(4)} (保证金已锁 $${marginLocked.toFixed(4)})`);

  // ── 4. 平空 ────────────────────────────────────────
  console.log(`\n[7] 平空 ${testQty} BTC...`);
  try {
    const coverOrder = await client.marketBuyByQty("BTCUSDT", testQty);
    console.log(`    ✅ 平空提交: orderId=${coverOrder.orderId}, status=${coverOrder.status}`);
    await sleep(2000);

    if (coverOrder.orderId) {
      const confirmed = await client.getOrder("BTCUSDT", coverOrder.orderId);
      console.log(`    确认状态: ${confirmed.status}, execQty=${confirmed.executedQty}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    ❌ 平空失败: ${msg}`);
  }

  // ── 5. 最终余额 ────────────────────────────────────
  const balFinal = await client.getUsdtBalance();
  const fee = balBefore - balFinal;
  console.log(`\n[8] 最终余额: $${balFinal.toFixed(4)}`);
  console.log(`    全程手续费消耗: $${fee.toFixed(4)} (${((fee / balBefore) * 100).toFixed(4)}%)`);
  console.log(`\n${"─".repeat(40)}`);
  console.log(fee > 0 && fee < 5
    ? "✅ 端到端测试通过！Futures Testnet 开空/平空全链路正常"
    : fee <= 0
    ? "⚠️  余额未减少，检查手续费设置"
    : "⚠️  手续费偏高，核查配置");
}

main().catch((e: unknown) => {
  console.error("测试异常:", e instanceof Error ? e.message : e);
  process.exit(1);
});
