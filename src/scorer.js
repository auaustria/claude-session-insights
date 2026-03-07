// Efficiency scoring engine
// Computes per-session score (0-100), overall score, tips, badges, and summaries.

import { generateOverallSummary, generateSessionSummary } from "./summarizer.js";

const WEIGHTS = {
  toolRatio: 0.3,
  cacheHitRate: 0.25,
  contextManagement: 0.2,
  modelFit: 0.15,
  promptSpecificity: 0.1,
};

// Score a single dimension 0-100
function scoreToolRatio(session) {
  const { toolCalls, userMessages } = session.totals;
  if (userMessages === 0) return 50;
  const ratio = toolCalls / userMessages;
  // < 2 is great (100), 2-5 is ok (50-100), > 5 is poor (0-50)
  if (ratio <= 2) return 100;
  if (ratio <= 5) return 100 - ((ratio - 2) / 3) * 50;
  if (ratio <= 10) return 50 - ((ratio - 5) / 5) * 50;
  return 0;
}

function scoreCacheHitRate(session) {
  const rate = session.totals.cacheHitRate;
  // > 60% is great, < 20% is poor
  if (rate >= 0.75) return 100;
  if (rate >= 0.6) return 80 + ((rate - 0.6) / 0.15) * 20;
  if (rate >= 0.2) return 20 + ((rate - 0.2) / 0.4) * 60;
  return rate / 0.2 * 20;
}

function scoreContextManagement(session) {
  const assistantTurns = session.turns.filter((t) => t.role === "assistant" && t.cost);
  if (assistantTurns.length < 5) return 70; // too short to judge

  // Find cost inflection: where rolling avg of cost-per-turn doubles
  const costs = assistantTurns.map((t) => t.cost);
  const windowSize = 3;
  let baselineCost = 0;
  for (let i = 0; i < Math.min(windowSize, costs.length); i++) {
    baselineCost += costs[i];
  }
  baselineCost /= Math.min(windowSize, costs.length);

  if (baselineCost === 0) return 70;

  let inflectionTurn = null;
  for (let i = windowSize; i <= costs.length - windowSize; i++) {
    let windowAvg = 0;
    for (let j = i; j < i + windowSize; j++) {
      windowAvg += costs[j];
    }
    windowAvg /= windowSize;
    if (windowAvg > baselineCost * 2) {
      inflectionTurn = i;
      break;
    }
  }

  if (!inflectionTurn) return 90; // no runaway cost, good

  // Did they clear near the inflection?
  const clearedNearInflection = session.clearPoints.some(
    (cp) => Math.abs(cp - inflectionTurn) <= 5
  );
  if (clearedNearInflection) return 85;

  // How much of the session ran past inflection?
  const fractionPastInflection = (assistantTurns.length - inflectionTurn) / assistantTurns.length;
  return Math.max(0, 70 - fractionPastInflection * 70);
}

function scoreModelFit(session) {
  const model = session.model || "";
  const { userMessages, toolCalls, estimatedCost } = session.totals;
  const isOpus = model.includes("opus");

  if (!isOpus) return 80;

  // Tool-to-message ratio: high ratio = mechanical work (edits, grep, bash)
  const toolRatio = userMessages > 0 ? toolCalls / userMessages : 0;

  // Cost per user message: how expensive is each interaction?
  const costPerMsg = userMessages > 0 ? estimatedCost / userMessages : 0;

  // Quick questions: few messages, low engagement — definitely Sonnet territory
  if (userMessages <= 3) return 20;

  // High tool ratio (>5x) = mostly automated work, Sonnet handles this fine
  if (toolRatio > 5) return 40;

  // Expensive per-message but tool-heavy: implementation work, not deep reasoning
  if (toolRatio > 3 && costPerMsg > 0.5) return 50;

  // Moderate sessions: some back-and-forth, some tool use
  if (toolRatio > 2) return 60;

  // Low tool ratio (<2x) with many messages = discussion/review/reasoning
  // This is where Opus genuinely shines
  if (userMessages >= 10 && toolRatio <= 2) return 90;

  return 75;
}

function scorePromptSpecificity(session) {
  const userTurns = session.turns.filter((t) => t.role === "user");
  if (userTurns.length === 0) return 50;

  let vagueCount = 0;
  for (let i = 0; i < userTurns.length; i++) {
    const turn = userTurns[i];
    if (turn.promptLength < 30) {
      // Check if the next assistant response was expensive
      const turnIdx = session.turns.indexOf(turn);
      const nextAssistant = session.turns
        .slice(turnIdx + 1)
        .find((t) => t.role === "assistant");
      if (nextAssistant && nextAssistant.tokens.input + nextAssistant.tokens.output > 50_000) {
        vagueCount++;
      }
    }
  }

  const vagueRate = vagueCount / userTurns.length;
  if (vagueRate === 0) return 100;
  if (vagueRate < 0.1) return 80;
  if (vagueRate < 0.3) return 50;
  return 20;
}

export function scoreSession(session) {
  const dimensions = {
    toolRatio: Math.round(scoreToolRatio(session)),
    cacheHitRate: Math.round(scoreCacheHitRate(session)),
    contextManagement: Math.round(scoreContextManagement(session)),
    modelFit: Math.round(scoreModelFit(session)),
    promptSpecificity: Math.round(scorePromptSpecificity(session)),
  };

  const score = Math.round(
    Object.entries(WEIGHTS).reduce(
      (sum, [key, weight]) => sum + dimensions[key] * weight,
      0
    )
  );

  const suggestedModel = suggestModel(session, dimensions);
  return { score, dimensions, suggestedModel };
}

function suggestModel(session, dimensions) {
  const model = session.model || "";
  const isOpus = model.includes("opus");
  const isHaiku = model.includes("haiku");

  if (isOpus && dimensions.modelFit <= 20) return "haiku";
  if (isOpus && dimensions.modelFit <= 60) return "sonnet";
  if (isHaiku && dimensions.modelFit < 60) return "sonnet";

  return null;
}

// --- Tips ---

function findCostInflection(session) {
  const assistantTurns = session.turns.filter((t) => t.role === "assistant" && t.cost);
  if (assistantTurns.length < 6) return null;

  const costs = assistantTurns.map((t) => t.cost);
  const windowSize = 3;
  let baseline = 0;
  for (let i = 0; i < windowSize; i++) baseline += costs[i];
  baseline /= windowSize;

  if (baseline === 0) return null;

  for (let i = windowSize; i <= costs.length - windowSize; i++) {
    let avg = 0;
    for (let j = i; j < i + windowSize; j++) avg += costs[j];
    avg /= windowSize;
    if (avg > baseline * 2) return i;
  }
  return null;
}

export function generateTips(session) {
  const tips = [];
  const { toolCalls, userMessages, cacheHitRate } = session.totals;
  const model = session.model || "";

  // High tool ratio
  if (userMessages > 0 && toolCalls / userMessages > 5) {
    tips.push({
      type: "high-tool-ratio",
      severity: "warning",
      message: `${toolCalls} tool calls across ${userMessages} messages (${(toolCalls / userMessages).toFixed(1)}x ratio). Try specifying file paths and line numbers to reduce searching.`,
    });
  }

  // Low cache hit rate
  if (cacheHitRate < 0.2 && session.totals.totalTokens > 50_000) {
    tips.push({
      type: "low-cache-hits",
      severity: "warning",
      message: `Only ${(cacheHitRate * 100).toFixed(0)}% cache hit rate. Group related tasks in one session to warm the cache.`,
    });
  }

  // Cost inflection
  const inflection = findCostInflection(session);
  if (inflection !== null) {
    const clearedNear = session.clearPoints.some((cp) => Math.abs(cp - inflection) <= 5);
    if (!clearedNear) {
      tips.push({
        type: "cost-inflection",
        severity: "info",
        message: `Cost per turn doubled around turn ${inflection}. Consider using /clear around that point.`,
      });
    }
  }

  // Opus on simple task
  if (model.includes("opus") && userMessages <= 10 && session.totals.totalTokens < 200_000) {
    tips.push({
      type: "model-mismatch",
      severity: "info",
      message: `Opus used for a ${userMessages}-message session. Sonnet handles quick tasks at 5x lower cost.`,
    });
  }

  return tips;
}

// --- Badges ---

const BADGE_DEFINITIONS = [
  {
    id: "surgical-prompter",
    name: "Surgical Prompter",
    description: "Your prompts guide Claude straight to the answer — minimal tool thrashing means less time and tokens wasted on searching and retrying.",
    criteria: "Tool call ratio < 2x across 5+ sessions",
    test: (sessions) => {
      const qualifying = sessions.filter(
        (s) => s.totals.userMessages > 0 && s.totals.toolCalls / s.totals.userMessages < 2
      );
      return qualifying.length >= 5;
    },
  },
  {
    id: "cache-whisperer",
    name: "Cache Whisperer",
    description: "You structure sessions so Claude reuses cached context instead of re-reading files — this dramatically cuts input token costs.",
    criteria: "Cache hit rate > 75% across 5+ sessions",
    test: (sessions) => {
      const qualifying = sessions.filter(
        (s) => s.totals.totalTokens > 10_000 && s.totals.cacheHitRate > 0.75
      );
      return qualifying.length >= 5;
    },
  },
  {
    id: "clean-slate",
    name: "Clean Slate",
    description: "You clear context before costs spiral — resetting at the right moment keeps sessions fast and cheap instead of letting them bloat.",
    criteria: "Uses /clear near cost inflection in 3+ sessions",
    test: (sessions) => {
      let count = 0;
      for (const s of sessions) {
        const inflection = findCostInflection(s);
        if (inflection !== null && s.clearPoints.some((cp) => Math.abs(cp - inflection) <= 5)) {
          count++;
        }
      }
      return count >= 3;
    },
  },
  {
    id: "model-sniper",
    name: "Model Sniper",
    description: "You pick the right model for the job — using Sonnet for quick tasks and reserving Opus for complex ones saves serious money.",
    criteria: "Appropriate model selection > 90% of sessions",
    test: (sessions) => {
      if (sessions.length < 5) return false;
      const appropriate = sessions.filter((s) => {
        const model = s.model || "";
        if (!model.includes("opus")) return true;
        return s.totals.userMessages > 10 || s.totals.totalTokens > 200_000;
      });
      return appropriate.length / sessions.length > 0.9;
    },
  },
  {
    id: "efficiency-diamond",
    name: "Efficiency Diamond",
    description: "Consistently high efficiency across all dimensions — you've built habits that keep every session lean and effective.",
    criteria: "Overall score > 85 sustained over 7 days",
    test: (sessions, scoredSessions) => {
      if (!scoredSessions || scoredSessions.length < 5) return false;
      const avg =
        scoredSessions.reduce((sum, s) => sum + s.score, 0) / scoredSessions.length;
      return avg > 85;
    },
  },
];

const NEGATIVE_BADGE_DEFINITIONS = [
  {
    id: "opus-addict",
    name: "Opus Addict",
    description: "You're reaching for the most expensive model even when a cheaper one would do the job just as well — that's a lot of money left on the table.",
    criteria: ">70% of sessions use Opus when Sonnet would suffice",
    test: (sessions, scoredSessions) => {
      if (!scoredSessions || scoredSessions.length < 5) return false;
      const opusMisuse = scoredSessions.filter((s) => {
        const model = s.model || "";
        return model.includes("opus") && s.dimensions.modelFit <= 60;
      });
      return opusMisuse.length / scoredSessions.length > 0.7;
    },
  },
  {
    id: "token-furnace",
    name: "Token Furnace",
    description: "Your sessions burn through tokens like firewood — try being more specific in prompts and clearing context when it gets stale.",
    criteria: "Average cost per user message > $0.50 across 5+ sessions",
    test: (sessions) => {
      const qualifying = sessions.filter((s) => s.totals.userMessages >= 3);
      if (qualifying.length < 5) return false;
      const avgCostPerMsg =
        qualifying.reduce((sum, s) => sum + s.totals.estimatedCost / s.totals.userMessages, 0) /
        qualifying.length;
      return avgCostPerMsg > 0.5;
    },
  },
  {
    id: "context-hoarder",
    name: "Context Hoarder",
    description: "You let context bloat until every turn costs a fortune — a well-timed /clear can cut costs dramatically.",
    criteria: "Cost inflection without /clear in 50%+ of long sessions",
    test: (sessions) => {
      const longSessions = sessions.filter(
        (s) => s.turns.filter((t) => t.role === "assistant" && t.cost).length >= 6
      );
      if (longSessions.length < 3) return false;
      let inflatedCount = 0;
      for (const s of longSessions) {
        const inflection = findCostInflection(s);
        if (inflection !== null && !s.clearPoints.some((cp) => Math.abs(cp - inflection) <= 5)) {
          inflatedCount++;
        }
      }
      return inflatedCount / longSessions.length >= 0.5;
    },
  },
  {
    id: "vague-commander",
    name: "Vague Commander",
    description: "Claude spends more time guessing what you want than doing it — adding file paths, line numbers, and specifics to your prompts would save a lot of tokens.",
    criteria: ">30% of prompts are vague and trigger expensive responses",
    test: (sessions) => {
      let totalUser = 0;
      let vagueCount = 0;
      for (const s of sessions) {
        const userTurns = s.turns.filter((t) => t.role === "user");
        totalUser += userTurns.length;
        for (const turn of userTurns) {
          if (turn.promptLength < 30) {
            const turnIdx = s.turns.indexOf(turn);
            const nextAssistant = s.turns.slice(turnIdx + 1).find((t) => t.role === "assistant");
            if (nextAssistant && nextAssistant.tokens.input + nextAssistant.tokens.output > 50_000) {
              vagueCount++;
            }
          }
        }
      }
      return totalUser >= 10 && vagueCount / totalUser > 0.3;
    },
  },
];

export function evaluateBadges(sessions, scoredSessions) {
  const positive = BADGE_DEFINITIONS.filter((b) => b.test(sessions, scoredSessions)).map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    criteria: b.criteria,
    negative: false,
  }));
  const negative = NEGATIVE_BADGE_DEFINITIONS.filter((b) => b.test(sessions, scoredSessions)).map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    criteria: b.criteria,
    negative: true,
  }));
  return [...positive, ...negative];
}

// --- Aggregate scoring ---

export function scoreAllSessions(sessions) {
  const scored = sessions.map((session) => {
    const { score, dimensions, suggestedModel } = scoreSession(session);
    const tips = generateTips(session);
    const summary = generateSessionSummary({ ...session, score, dimensions, tips });
    return { ...session, score, dimensions, suggestedModel, tips, summary };
  });

  const recentSessions = scored.filter((s) => {
    if (!s.startTime) return false;
    const age = Date.now() - new Date(s.startTime).getTime();
    return age < 7 * 24 * 60 * 60 * 1000; // 7 days
  });

  const sessionsForOverall = recentSessions.length > 0 ? recentSessions : scored;
  const overallScore =
    sessionsForOverall.length > 0
      ? Math.round(
          sessionsForOverall.reduce((sum, s) => sum + s.score, 0) / sessionsForOverall.length
        )
      : 0;

  const badges = evaluateBadges(sessions, scored);

  // Collect all tips, deduplicate by type, keep top ones
  const allTips = scored.flatMap((s) =>
    s.tips.map((t) => ({ ...t, sessionId: s.id, project: s.project }))
  );

  // Daily scores
  const dailyMap = {};
  for (const s of scored) {
    if (!s.startTime) continue;
    const date = s.startTime.slice(0, 10);
    if (!dailyMap[date]) dailyMap[date] = { date, scores: [], sessions: 0, tokens: 0, cost: 0 };
    dailyMap[date].scores.push(s.score);
    dailyMap[date].sessions++;
    dailyMap[date].tokens += s.totals.totalTokens;
    dailyMap[date].cost += s.totals.estimatedCost;
  }
  const dailyScores = Object.values(dailyMap)
    .map((d) => ({
      date: d.date,
      score: Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length),
      sessions: d.sessions,
      tokens: d.tokens,
      cost: d.cost,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const overallSummary = generateOverallSummary({ sessions: scored, overallScore, badges, tips: allTips });

  return {
    sessions: scored,
    overallScore,
    badges,
    tips: allTips,
    dailyScores,
    overallSummary,
  };
}
