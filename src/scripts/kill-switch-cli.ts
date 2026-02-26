/**
 * Kill Switch CLI — 熔断器命令行工具 (P6.7)
 *
 * 用法：
 *   npx tsx src/scripts/kill-switch-cli.ts status
 *   npx tsx src/scripts/kill-switch-cli.ts activate "BTC 暴跌"
 *   npx tsx src/scripts/kill-switch-cli.ts activate "手动熔断" --auto-resume-hours 4
 *   npx tsx src/scripts/kill-switch-cli.ts deactivate
 */

import {
  readKillSwitch,
  activateKillSwitch,
  deactivateKillSwitch,
  isKillSwitchActive,
} from "../health/kill-switch.js";

const [, , command, ...args] = process.argv;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
switch (command) {
  case "status": {
    const state = readKillSwitch();
    const active = isKillSwitchActive();
    if (active) {
      console.log(`⛔ Kill Switch 状态: 【已激活】`);
      console.log(`   原因: ${state.reason}`);
      console.log(`   激活时间: ${formatTime(state.triggeredAt)}`);
      if (state.autoResumeAt) {
        const remaining = Math.max(0, state.autoResumeAt - Date.now());
        const mins = Math.ceil(remaining / 60_000);
        console.log(`   自动恢复: ${formatTime(state.autoResumeAt)} (${mins}分钟后)`);
      } else {
        console.log(`   恢复方式: 手动解除`);
      }
    } else {
      console.log(`✅ Kill Switch 状态: 【未激活】`);
    }
    break;
  }

  case "activate": {
    const reason = args[0] ?? "手动激活";
    // 解析 --auto-resume-hours 参数
    const hrIdx = args.indexOf("--auto-resume-hours");
    const autoResumeHours = hrIdx >= 0 ? parseFloat(args[hrIdx + 1] ?? "0") : 0;
    const autoResumeMs = autoResumeHours > 0 ? autoResumeHours * 3_600_000 : undefined;

    activateKillSwitch(reason, autoResumeMs);
    console.log(`⛔ Kill Switch 已激活！`);
    console.log(`   原因: ${reason}`);
    if (autoResumeMs !== undefined) {
      console.log(`   自动恢复: ${autoResumeHours} 小时后`);
    } else {
      console.log(`   恢复方式: 手动运行 deactivate`);
    }
    break;
  }

  case "deactivate": {
    const wasActive = isKillSwitchActive();
    deactivateKillSwitch();
    if (wasActive) {
      console.log(`✅ Kill Switch 已解除。`);
    } else {
      console.log(`ℹ️  Kill Switch 本来就未激活，已重置状态文件。`);
    }
    break;
  }

  default: {
    console.log(`Kill Switch CLI — 熔断器工具

用法:
  npx tsx src/scripts/kill-switch-cli.ts <command> [options]

命令:
  status                           查看当前状态
  activate <原因>                  激活熔断器
  activate <原因> --auto-resume-hours <N>  N小时后自动恢复
  deactivate                       手动解除熔断

示例:
  npx tsx src/scripts/kill-switch-cli.ts status
  npx tsx src/scripts/kill-switch-cli.ts activate "BTC 1小时跌8%"
  npx tsx src/scripts/kill-switch-cli.ts activate "手动熔断" --auto-resume-hours 4
  npx tsx src/scripts/kill-switch-cli.ts deactivate
`);
    process.exit(command ? 1 : 0);
  }
}
