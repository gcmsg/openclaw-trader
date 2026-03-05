/**
 * Futures Testnet End-to-End Test
 * 1. Connectivity (ping / balance / market data)
 * 2. Open short → query confirmation → close short
 * 3. Verify balance changes (fees)
 */
import { BinanceClient } from "../exchange/binance-client.js";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const client = new BinanceClient(".secrets/binance-futures-testnet.json", true, "futures");

  console.log("=== Futures Testnet End-to-End Test ===\n");

  // ── 1. Connectivity ──────────────────────────────────────
  const ok = await client.ping();
  console.log(`[1] ping: ${ok ? "✅ OK" : "❌ Failed"}`);

  const bal = await client.getUsdtBalance();
  console.log(`[2] USDT balance: $${bal.toFixed(4)}`);

  const btcPrice = await client.getPrice("BTCUSDT");
  console.log(`[3] BTCUSDT price: $${btcPrice.toFixed(2)}`);

  // ── 2. Clean up residual positions (may remain from previous test) ──────────────
  console.log("\n[4] Cleaning residual short positions (if any)...");
  try {
    const cleanCover = await client.marketBuyByQty("BTCUSDT", 0.002);
    console.log(`    Clean up successful: orderId=${cleanCover.orderId}, status=${cleanCover.status}`);
    await sleep(2000);
    const balAfterClean = await client.getUsdtBalance();
    console.log(`    Balance after cleanup: $${balAfterClean.toFixed(4)}`);
  } catch (e: unknown) {
    // May not have a position, ignore error
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ReduceOnly") || msg.includes("reduce only") || msg.includes("-2022")) {
      console.log("    No residual positions, skipping");
    } else {
      console.log(`    Cleanup error (ignored): ${msg.slice(0, 80)}`);
    }
  }

  const balBefore = await client.getUsdtBalance();
  console.log(`\n[5] Test starting balance: $${balBefore.toFixed(4)}`);

  // ── 3. Open short ────────────────────────────────────────
  const testQty = 0.002; // 0.002 BTC ~ $127, above minimum notional value $100
  console.log(`\n[6] Opening short ${testQty} BTC (~$${(testQty * btcPrice).toFixed(0)})...`);

  let shortOrderId: number | null = null;
  try {
    const shortOrder = await client.marketSell("BTCUSDT", testQty);
    shortOrderId = shortOrder.orderId;
    console.log(`    ✅ Short submitted: orderId=${shortOrder.orderId}, status=${shortOrder.status}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    ❌ Short failed: ${msg}`);
    process.exit(1);
  }

  // Wait for Futures testnet async execution
  await sleep(2000);

  // Query final status
  if (shortOrderId) {
    try {
      const confirmed = await client.getOrder("BTCUSDT", shortOrderId);
      console.log(`    Confirmed status: ${confirmed.status}, execQty=${confirmed.executedQty}, avgPrice=${confirmed.price}`);
    } catch (e: unknown) {
      console.log(`    Status query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const balAfterShort = await client.getUsdtBalance();
  const marginLocked = balBefore - balAfterShort;
  console.log(`    Balance change: $${balBefore.toFixed(4)} → $${balAfterShort.toFixed(4)} (margin locked $${marginLocked.toFixed(4)})`);

  // ── 4. Close short ────────────────────────────────────────
  console.log(`\n[7] Closing short ${testQty} BTC...`);
  try {
    const coverOrder = await client.marketBuyByQty("BTCUSDT", testQty);
    console.log(`    ✅ Cover submitted: orderId=${coverOrder.orderId}, status=${coverOrder.status}`);
    await sleep(2000);

    if (coverOrder.orderId) {
      const confirmed = await client.getOrder("BTCUSDT", coverOrder.orderId);
      console.log(`    Confirmed status: ${confirmed.status}, execQty=${confirmed.executedQty}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    ❌ Cover failed: ${msg}`);
  }

  // ── 5. Final balance ────────────────────────────────────
  const balFinal = await client.getUsdtBalance();
  const fee = balBefore - balFinal;
  console.log(`\n[8] Final balance: $${balFinal.toFixed(4)}`);
  console.log(`    Total fee consumed: $${fee.toFixed(4)} (${((fee / balBefore) * 100).toFixed(4)}%)`);
  console.log(`\n${"─".repeat(40)}`);
  console.log(fee > 0 && fee < 5
    ? "✅ End-to-end test passed! Futures Testnet short/cover full pipeline works"
    : fee <= 0
    ? "⚠️  Balance did not decrease, check fee settings"
    : "⚠️  Fee seems high, verify configuration");
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

main().catch((e: unknown) => {
  console.error("Test error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
