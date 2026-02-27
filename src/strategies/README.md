# src/strategies/ — 策略插件体系（F4）

> ⚠️ 注意：本目录与 `src/strategy/` 命名相近，但职责完全不同。

## 职责

本目录实现 **F4 Strategy Plugin 架构**：将策略逻辑抽象为可插拔插件，
通过注册表统一管理，`signal-engine.ts` 通过 `getStrategy(id)` 动态加载。

## 文件说明

| 文件 | 职责 |
|---|---|
| `types.ts` | Strategy 接口定义（`Strategy`, `StrategyContext`, `ExitResult` 等） |
| `registry.ts` | 策略注册表（`registerStrategy`, `getStrategy`, `listStrategies`） |
| `index.ts` | 注册入口（import 即触发所有内置策略注册，对外重导出公共 API） |
| `state-store.ts` | 策略状态持久化工厂（`StateStore` 接口） |
| `default.ts` | 默认策略插件（MA+RSI+MACD 三重确认） |
| `rsi-reversal.ts` | RSI 均值回归策略（超卖买入，连续亏损保护） |
| `breakout.ts` | 突破策略（BB 突破 + ATR 确认） |
| `ensemble.ts` | 组合策略核心逻辑 |
| `ensemble-strategy.ts` | 组合策略插件（多策略投票） |

## 与 src/strategy/ 的区别

| | `src/strategies/` | `src/strategy/` |
|---|---|---|
| 性质 | 策略插件体系（F4） | 计算组件库 |
| 内容 | Strategy 接口、注册表、具体实现 | 指标、过滤器、仓位管理 |
| 调用方 | signal-engine.ts 通过 registry 调用 | engine.ts, runner.ts, monitor.ts |
| 扩展方式 | 新建 .ts 文件 + `registerStrategy()` + 加入 index.ts | 不扩展，修改已有文件 |

## 新增策略步骤

1. 在本目录创建 `my-strategy.ts`，实现 `Strategy` 接口
2. 在 `index.ts` 中 `import "./my-strategy.js"` 触发注册
3. 在 `config/strategies/` 创建对应 YAML profile（引用 `strategy_id`）
