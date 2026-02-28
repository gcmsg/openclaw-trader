/**
 * P6.8 — Dashboard 启动脚本
 *
 * 启动 Web 实时仪表盘服务器，打印访问地址。
 * 用法：npm run dashboard
 *       DASHBOARD_PORT=3000 npm run dashboard
 */

import { startDashboardServer, stopDashboardServer } from "../web/dashboard-server.js";

const PORT = process.env["DASHBOARD_PORT"] ? parseInt(process.env["DASHBOARD_PORT"], 10) : 8080;

console.log(`\n📊 OpenClaw Trader — Web Dashboard`);
console.log(`────────────────────────────────────`);
console.log(`  启动服务器 (port: ${PORT})...`);
console.log(`  访问地址: http://localhost:${PORT}`);
console.log(`  API:      http://localhost:${PORT}/api/data`);
console.log(`  Health:   http://localhost:${PORT}/api/health`);
console.log(`  按 Ctrl+C 停止\n`);

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

startDashboardServer(PORT);

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n[dashboard] 收到 SIGINT，正在关闭...");
  stopDashboardServer();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopDashboardServer();
  process.exit(0);
});
