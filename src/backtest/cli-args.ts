/**
 * Backtest CLI Argument Parsing Module
 *
 * Separates parseArgs from the script entry point into the domain directory for easier testing.
 * CLI entry: src/scripts/backtest.ts
 */

// ─────────────────────────────────────────────────────
// Types
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
  /** Delay signal execution by one candle (eliminates look-ahead bias). CLI: --next-open */
  signalToNextOpen: boolean;
}

// ─────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────

/**
 * Parse backtest CLI arguments (pass in process.argv.slice(2))
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
    // nextArg helper: safely get the next argument
    const nextArg = (): string => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`Argument ${arg} is missing a value`);
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
        break; // skip unknown arguments or undefined (noUncheckedIndexedAccess)
    }
  }

  return args;
}
