/**
 * 宏观市场数据
 *
 * 数据源：Yahoo Finance 非官方 API（免费，无需 Key）
 *
 * 为什么宏观重要：
 *   DXY（美元指数）与加密货币强负相关——美元强时风险资产承压
 *   S&P500 代表整体风险情绪——科技股/纳指与 BTC 相关性 > 0.7
 *   VIX（恐惧指数）衡量市场恐慌程度
 *
 * 相关性规律（经验）：
 *   DXY 月线下跌  → 利好加密（流动性宽松）
 *   SPX 连续下跌  → 加密大概率跟跌（去风险情绪）
 *   VIX > 25     → 市场恐慌，不适合逆势加仓
 *   VIX < 15     → 市场平静，趋势行情可靠
 */

import https from "https";

// 强制 IPv4（服务器 IPv6 不可达时）
// family 是 net.LookupOptions 的属性，通过类型断言传入
const ipv4Agent = new https.Agent({ family: 4 } as https.AgentOptions);

// ─── 类型定义 ──────────────────────────────────────────

export interface MacroAsset {
  symbol: string;
  name: string;
  price: number;
  change1d: number;       // 1 日涨跌幅（%）
  change5d: number;       // 5 日涨跌幅（%）
  trend: "bullish" | "bearish" | "neutral";
  trendLabel: string;
}

export interface MacroContext {
  dxy: MacroAsset | null;      // 美元指数
  spx: MacroAsset | null;      // 标普500
  vix: MacroAsset | null;      // 恐惧指数（可选）
  cryptoEnvironment: "risk_on" | "risk_off" | "mixed" | "unknown";
  cryptoEnvironmentLabel: string;
  summary: string;             // 一句话总结
  fetchedAt: number;
}

// ─── FRED API（美联储经济数据，免费无需 Key） ──────────────
// DXY（贸易加权美元）: DTWEXBGS
// S&P 500:            SP500
// VIX:                VIXCLS
// 返回 CSV 格式：DATE,VALUE（其中空值表示假日）

function fetchFredCsv(seriesId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hostname = "fred.stlouisfed.org";
    const path = `/graph/fredgraph.csv?id=${seriesId}`;
    const req = https.request(
      { hostname, path, method: "GET", agent: ipv4Agent, headers: { "User-Agent": "curl/7.88" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => { resolve(data); });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("FRED timeout")); });
    req.end();
  });
}

/** 解析 FRED CSV，返回最后 N 条有效数据 */
function parseFredCsv(csv: string, rows = 8): { date: string; value: number }[] {
  return csv
    .split("\n")
    .slice(1)                          // 跳过 header
    .filter((line) => line.includes(","))
    .map((line) => {
      const [date, val] = line.trim().split(",") as [string, string];
      return { date, value: parseFloat(val) };
    })
    .filter((r) => !isNaN(r.value))   // 去掉空值行（假日）
    .slice(-rows);
}

function buildMacroAsset(
  seriesId: string,
  name: string,
  csv: string
): MacroAsset | null {
  const data = parseFredCsv(csv, 8);
  if (data.length < 2) return null;

  const latest = data.at(-1);
  const prev = data.at(-2);
  const first = data.at(0);
  if (!latest || !prev || !first) return null;

  const price = latest.value;
  const change1d = prev.value > 0 ? ((price - prev.value) / prev.value) * 100 : 0;
  const change5d = first.value > 0 ? ((price - first.value) / first.value) * 100 : 0;

  let trend: MacroAsset["trend"];
  if (change1d > 0.2 && change5d > 0.3) trend = "bullish";
  else if (change1d < -0.2 && change5d < -0.3) trend = "bearish";
  else trend = "neutral";

  const trendEmoji = trend === "bullish" ? "📈" : trend === "bearish" ? "📉" : "➡️";
  const trendLabel = `${trendEmoji} ${change1d >= 0 ? "+" : ""}${change1d.toFixed(2)}% 昨日 / ${change5d >= 0 ? "+" : ""}${change5d.toFixed(2)}% 近5日`;

  return { symbol: seriesId, name, price, change1d, change5d, trend, trendLabel };
}

// ─── 公开接口 ──────────────────────────────────────────

/** 获取 DXY（贸易加权美元指数，FRED: DTWEXBGS） */
export async function getDxy(): Promise<MacroAsset | null> {
  try {
    const csv = await fetchFredCsv("DTWEXBGS");
    return buildMacroAsset("DXY", "美元指数 DXY", csv);
  } catch { return null; }
}

/** 获取 S&P 500（FRED: SP500） */
export async function getSP500(): Promise<MacroAsset | null> {
  try {
    const csv = await fetchFredCsv("SP500");
    return buildMacroAsset("SPX", "标普500 SPX", csv);
  } catch { return null; }
}

/** 获取 VIX（FRED: VIXCLS） */
export async function getVix(): Promise<MacroAsset | null> {
  try {
    const csv = await fetchFredCsv("VIXCLS");
    return buildMacroAsset("VIX", "恐惧指数 VIX", csv);
  } catch { return null; }
}

/**
 * 获取完整宏观上下文
 * 并发请求所有数据源，超时 8s
 */
export async function getMacroContext(): Promise<MacroContext> {
  const [dxy, spx, vix] = await Promise.allSettled([getDxy(), getSP500(), getVix()]);

  const dxyData = dxy.status === "fulfilled" ? dxy.value : null;
  const spxData = spx.status === "fulfilled" ? spx.value : null;
  const vixData = vix.status === "fulfilled" ? vix.value : null;

  // 综合判断加密市场的宏观环境
  const dxyBearish = dxyData?.trend === "bearish";    // 美元弱 → 利好加密
  const dxyBullish = dxyData?.trend === "bullish";    // 美元强 → 利空加密
  const spxBullish = spxData?.trend === "bullish";    // 美股涨 → 风险偏好好
  const spxBearish = spxData?.trend === "bearish";    // 美股跌 → 风险偏好差
  const vixHigh = vixData ? vixData.price > 25 : false;

  // 用函数避免 no-useless-assignment lint 规则
  const getEnv = (): [MacroContext["cryptoEnvironment"], string, string] => {
    if (vixHigh)             return ["risk_off", "🚨 市场恐慌（VIX > 25），避险情绪主导", "VIX 偏高，市场风险偏好弱，加密市场承压"];
    if (dxyBullish && spxBearish) return ["risk_off", "🔴 宏观不利（美元强 + 美股跌）", "美元走强叠加美股回调，加密货币面临流动性压力"];
    if (dxyBearish && spxBullish) return ["risk_on",  "🟢 宏观有利（美元弱 + 美股涨）", "美元回落叠加美股上涨，风险偏好改善，利好加密"];
    if (dxyBullish || spxBearish) return ["mixed",    "🟡 宏观偏负（注意风险）", dxyBullish ? "美元走强，对加密有一定压制" : "美股走弱，风险情绪受压"];
    if (dxyBearish || spxBullish) return ["mixed",    "🟡 宏观偏正（谨慎乐观）", dxyBearish ? "美元偏弱，流动性环境改善" : "美股走强，风险偏好回升"];
    if (dxyData || spxData)       return ["mixed",    "⚪ 宏观中性", "美元和美股均无明显方向，加密市场受自身逻辑主导"];
    return ["unknown", "❓ 宏观数据获取失败", "无法获取宏观数据，基于纯技术面分析"];
  };

  const [cryptoEnvironment, cryptoEnvironmentLabel, summary] = getEnv();

  return {
    dxy: dxyData,
    spx: spxData,
    vix: vixData,
    cryptoEnvironment,
    cryptoEnvironmentLabel,
    summary,
    fetchedAt: Date.now(),
  };
}

/** 格式化宏观数据报告（Telegram 格式） */
export function formatMacroReport(ctx: MacroContext): string {
  const lines: string[] = ["🌍 **宏观市场背景**\n"];

  if (ctx.dxy) lines.push(`💵 ${ctx.dxy.name}: $${ctx.dxy.price.toFixed(2)}  ${ctx.dxy.trendLabel}`);
  else lines.push("💵 DXY: 数据获取失败");

  if (ctx.spx) lines.push(`📊 ${ctx.spx.name}: ${ctx.spx.price.toFixed(0)}  ${ctx.spx.trendLabel}`);
  else lines.push("📊 SPX: 数据获取失败");

  if (ctx.vix) {
    const vixWarning = ctx.vix.price > 30 ? " ⚠️ 极度恐慌" : ctx.vix.price > 20 ? " ⚠️ 偏高" : " 正常";
    lines.push(`😨 ${ctx.vix.name}: ${ctx.vix.price.toFixed(2)}${vixWarning}`);
  }

  lines.push(`\n**加密环境**: ${ctx.cryptoEnvironmentLabel}`);
  lines.push(`→ ${ctx.summary}`);

  return lines.join("\n");
}
