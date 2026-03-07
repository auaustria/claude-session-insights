import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { writeFile } from "node:fs/promises";
import { parseAllSessions } from "./parser.js";
import { scoreAllSessions } from "./scorer.js";

function hashUsername() {
  const username = userInfo().username;
  return createHash("sha256").update(username).digest("hex").slice(0, 16);
}

export async function generateExport(outputPath = "team-export.json") {
  const sessions = await parseAllSessions();
  const data = scoreAllSessions(sessions);

  const dates = data.sessions
    .map((s) => s.startTime)
    .filter(Boolean)
    .sort();

  // Model mix
  const modelTokens = {};
  let totalTokens = 0;
  for (const s of data.sessions) {
    const model = s.model || "unknown";
    const family = model.includes("opus")
      ? "opus"
      : model.includes("haiku")
        ? "haiku"
        : "sonnet";
    modelTokens[family] = (modelTokens[family] || 0) + s.totals.totalTokens;
    totalTokens += s.totals.totalTokens;
  }
  const modelMix = {};
  for (const [k, v] of Object.entries(modelTokens)) {
    modelMix[k] = totalTokens > 0 ? Math.round((v / totalTokens) * 100) / 100 : 0;
  }

  const totalCost = data.sessions.reduce((s, x) => s + x.totals.estimatedCost, 0);
  const avgCacheHitRate =
    data.sessions.length > 0
      ? data.sessions.reduce((s, x) => s + x.totals.cacheHitRate, 0) / data.sessions.length
      : 0;
  const avgToolRatio =
    data.sessions.length > 0
      ? data.sessions.reduce((s, x) => {
          const um = x.totals.userMessages || 1;
          return s + x.totals.toolCalls / um;
        }, 0) / data.sessions.length
      : 0;

  // Unique tip types
  const tipTypes = [...new Set(data.tips.map((t) => t.type))];

  const exportData = {
    exportVersion: "1.0",
    devId: hashUsername(),
    exportDate: new Date().toISOString().slice(0, 10),
    period: {
      from: dates[0]?.slice(0, 10) || null,
      to: dates[dates.length - 1]?.slice(0, 10) || null,
    },
    summary: {
      efficiencyScore: data.overallScore,
      totalSessions: data.sessions.length,
      totalTokens,
      estimatedCost: Math.round(totalCost * 100) / 100,
      cacheHitRate: Math.round(avgCacheHitRate * 100) / 100,
      toolCallRatio: Math.round(avgToolRatio * 10) / 10,
      modelMix,
    },
    dailyScores: data.dailyScores,
    topInsights: tipTypes,
    badges: data.badges.map((b) => b.id),
  };

  await writeFile(outputPath, JSON.stringify(exportData, null, 2) + "\n");
  return exportData;
}
