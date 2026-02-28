/**
 * 回测 CLI 参数解析模块
 *
 * 将 parseArgs 从脚本入口分离到领域目录，便于测试。
 * CLI 入口：src/scripts/backtest.ts
 */

// ─────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────

export interface BacktestCliArgs {
  strategy?: string;
  days: number;
  timeframe?: string;
  symbols?: string[];
  initialUsdt: number;
  save: boolean;
  compare: boolean;
  slippageSweep: boolean;
  spreadBps: number;
  /** 信号延迟一根 K 线执行（消除前视偏差）。CLI: --next-open */
  signalToNextOpen: boolean;
}

// ─────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────

/**
 * 解析回测 CLI 参数（process.argv.slice(2) 传入）
 */
export function parseBacktestArgs(argv: string[]): BacktestCliArgs {
  const args: BacktestCliArgs = {
    days: 90,
    initialUsdt: 1000,
    save: true,
    compare: false,
    slippageSweep: false,
    spreadBps: 0,
    signalToNextOpen: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // nextArg 辅助：安全取下一个参数
    const nextArg = (): string => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`参数 ${arg} 缺少值`);
      return val;
    };
    switch (arg) {
      case "--strategy":
      case "-s":
        args.strategy = nextArg();
        break;
      case "--days":
      case "-d":
        args.days = parseInt(nextArg(), 10);
        break;
      case "--timeframe":
      case "-t":
        args.timeframe = nextArg();
        break;
      case "--symbols":
      case "-S":
        args.symbols = nextArg()
          .split(",")
          .map((s) => s.trim().toUpperCase());
        break;
      case "--initial-usdt":
        args.initialUsdt = parseFloat(nextArg());
        break;
      case "--no-save":
        args.save = false;
        break;
      case "--compare":
        args.compare = true;
        break;
      case "--slippage-sweep":
        args.slippageSweep = true;
        break;
      case "--spread":
        args.spreadBps = parseFloat(nextArg());
        break;
      case "--next-open":
        args.signalToNextOpen = true;
        break;
      case undefined:
      default:
        break; // 未知参数或 undefined（noUncheckedIndexedAccess）跳过
    }
  }

  return args;
}
