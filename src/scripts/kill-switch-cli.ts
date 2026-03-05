/**
 * Kill Switch CLI — Circuit Breaker Command Line Tool (P6.7)
 *
 * Usage:
 *   npx tsx src/scripts/kill-switch-cli.ts status
 *   npx tsx src/scripts/kill-switch-cli.ts activate "BTC crash"
 *   npx tsx src/scripts/kill-switch-cli.ts activate "manual circuit break" --auto-resume-hours 4
 *   npx tsx src/scripts/kill-switch-cli.ts deactivate
 */

import {
  readKillSwitch,
  activateKillSwitch,
  deactivateKillSwitch,
  isKillSwitchActive,
} from "../health/kill-switch.js";

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  process.exit(1);
});

const [, , command, ...args] = process.argv;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Shanghai" });
}

// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
switch (command) {
  case "status": {
    const state = readKillSwitch();
    const active = isKillSwitchActive();
    if (active) {
      console.log(`⛔ Kill Switch Status: [ACTIVATED]`);
      console.log(`   Reason: ${state.reason}`);
      console.log(`   Activated at: ${formatTime(state.triggeredAt)}`);
      if (state.autoResumeAt) {
        const remaining = Math.max(0, state.autoResumeAt - Date.now());
        const mins = Math.ceil(remaining / 60_000);
        console.log(`   Auto-resume: ${formatTime(state.autoResumeAt)} (in ${mins} minutes)`);
      } else {
        console.log(`   Recovery: Manual deactivation`);
      }
    } else {
      console.log(`✅ Kill Switch Status: [NOT ACTIVATED]`);
    }
    break;
  }

  case "activate": {
    const reason = args[0] ?? "manually activated";
    // Parse --auto-resume-hours argument
    const hrIdx = args.indexOf("--auto-resume-hours");
    const autoResumeHours = hrIdx >= 0 ? parseFloat(args[hrIdx + 1] ?? "0") : 0;
    const autoResumeMs = autoResumeHours > 0 ? autoResumeHours * 3_600_000 : undefined;

    activateKillSwitch(reason, autoResumeMs);
    console.log(`⛔ Kill Switch activated!`);
    console.log(`   Reason: ${reason}`);
    if (autoResumeMs !== undefined) {
      console.log(`   Auto-resume: in ${autoResumeHours} hours`);
    } else {
      console.log(`   Recovery: manually run deactivate`);
    }
    break;
  }

  case "deactivate": {
    const wasActive = isKillSwitchActive();
    deactivateKillSwitch();
    if (wasActive) {
      console.log(`✅ Kill Switch deactivated.`);
    } else {
      console.log(`ℹ️  Kill Switch was not activated, state file has been reset.`);
    }
    break;
  }

  default: {
    console.log(`Kill Switch CLI — Circuit Breaker Tool

Usage:
  npx tsx src/scripts/kill-switch-cli.ts <command> [options]

Commands:
  status                           View current status
  activate <reason>                Activate circuit breaker
  activate <reason> --auto-resume-hours <N>  Auto-resume after N hours
  deactivate                       Manually deactivate circuit breaker

Examples:
  npx tsx src/scripts/kill-switch-cli.ts status
  npx tsx src/scripts/kill-switch-cli.ts activate "BTC dropped 8% in 1 hour"
  npx tsx src/scripts/kill-switch-cli.ts activate "manual circuit break" --auto-resume-hours 4
  npx tsx src/scripts/kill-switch-cli.ts deactivate
`);
    process.exit(command ? 1 : 0);
  }
}
