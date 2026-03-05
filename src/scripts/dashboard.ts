/**
 * P6.8 — Dashboard Launch Script
 *
 * Starts the web real-time dashboard server and prints access URLs.
 * Usage: npm run dashboard
 *        DASHBOARD_PORT=3000 npm run dashboard
 */

import { startDashboardServer, stopDashboardServer } from "../web/dashboard-server.js";

const PORT = process.env["DASHBOARD_PORT"] ? parseInt(process.env["DASHBOARD_PORT"], 10) : 8080;

console.log(`\n📊 OpenClaw Trader — Web Dashboard`);
console.log(`────────────────────────────────────`);
console.log(`  Starting server (port: ${PORT})...`);
console.log(`  Access URL: http://localhost:${PORT}`);
console.log(`  API:      http://localhost:${PORT}/api/data`);
console.log(`  Health:   http://localhost:${PORT}/api/health`);
console.log(`  Press Ctrl+C to stop\n`);

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

startDashboardServer(PORT);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[dashboard] Received SIGINT, shutting down...");
  stopDashboardServer();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopDashboardServer();
  process.exit(0);
});
