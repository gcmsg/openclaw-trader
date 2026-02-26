/**
 * 集成投票策略插件（Ensemble Strategy）
 *
 * Strategy id = "ensemble"
 * 内部调用 ensembleVote() 聚合多个子策略的信号，通过加权投票决定最终方向。
 *
 * 配置方式（strategy.yaml）：
 *   strategy_id: "ensemble"
 *   ensemble:
 *     strategies:
 *       - id: "rsi-reversal"
 *         weight: 0.5
 *       - id: "breakout"
 *         weight: 0.5
 *     threshold: 0.6
 *     unanimous: false
 *
 * VoteResult 会存入 ctx.extra.ensembleVote 供日志/通知使用。
 */

import type { Strategy, StrategyContext } from "./types.js";
import type { SignalType } from "../types.js";
import { registerStrategy } from "./registry.js";
import { ensembleVote } from "./ensemble.js";
import type { EnsembleConfig } from "./ensemble.js";

const ensembleStrategy: Strategy = {
  id: "ensemble",
  name: "集成投票",
  description:
    "将多个策略的信号通过加权投票合并，支持 threshold（最低置信度）和 unanimous（全票一致）两种模式。",

  populateSignal(ctx: StrategyContext): SignalType {
    // 从配置中读取 ensemble 配置
    const ensembleCfg = (ctx.cfg as { ensemble?: EnsembleConfig }).ensemble;

    if (!ensembleCfg) {
      console.warn("[ensemble-strategy] 未配置 ensemble，返回 none");
      return "none";
    }

    // 执行加权投票
    const result = ensembleVote(ensembleCfg, ctx);

    // 将 VoteResult 存入 ctx.extra 供日志/通知使用
    if (ctx.extra !== undefined) {
      // ctx.extra 是 ExtraIndicators（Record<string, number | boolean | undefined>）
      // 将投票结果以 JSON 字符串形式存入（类型约束不支持嵌套对象）
      ctx.extra["ensembleSignal"] = result.signal === "none" ? 0 : 1;
      ctx.extra["ensembleBuyScore"] = result.buyScore;
      ctx.extra["ensembleSellScore"] = result.sellScore;
      ctx.extra["ensembleShortScore"] = result.shortScore;
      ctx.extra["ensembleCoverScore"] = result.coverScore;
      ctx.extra["ensembleConfidence"] = result.confidence;
      ctx.extra["ensembleUnanimous"] = result.unanimous;
    }

    return result.signal;
  },
};

// 自动注册（import 时触发）
registerStrategy(ensembleStrategy);

export { ensembleStrategy };
