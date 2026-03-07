// Rule-based summary generation for overall and per-session insights.

function pct(n) {
  return Math.round(n * 100);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- Overall Summary ---

export function generateOverallSummary(scoredData) {
  const { sessions, overallScore, badges, tips } = scoredData;
  if (sessions.length === 0) {
    return { paragraphs: ["No sessions found yet. Start using Claude Code and come back!"], patterns: [], recommendations: [] };
  }

  const patterns = [];
  const recommendations = [];

  // 1. Session length habits
  const sessionsWithInflection = sessions.filter(s => {
    const tip = s.tips?.find(t => t.type === "cost-inflection");
    return !!tip;
  });
  const inflectionRate = sessionsWithInflection.length / sessions.length;

  const avgTurns = sessions.reduce((sum, s) => sum + s.totals.userMessages, 0) / sessions.length;
  const longSessions = sessions.filter(s => s.totals.userMessages > 20);
  const longRate = longSessions.length / sessions.length;

  if (inflectionRate > 0.3) {
    patterns.push({
      type: "session-length",
      sentiment: "negative",
      text: `${pct(inflectionRate)}% of your sessions hit a cost inflection point where per-turn cost doubles — typically from context growth.`,
    });
    const clearUsers = sessions.filter(s => s.clearPoints.length > 0).length;
    if (clearUsers / sessions.length < 0.3) {
      recommendations.push("Use /clear when switching subtasks within a long session. This resets context and cuts per-turn cost back down.");
    } else {
      recommendations.push("You already use /clear sometimes — try to use it right when you notice you're switching to a different subtask.");
    }
  } else if (longRate > 0.3) {
    patterns.push({
      type: "session-length",
      sentiment: "neutral",
      text: `${pct(longRate)}% of your sessions run 20+ turns, but cost stays controlled. You manage long sessions well.`,
    });
  } else {
    patterns.push({
      type: "session-length",
      sentiment: "positive",
      text: `Your sessions are focused — averaging ${Math.round(avgTurns)} turns. Short, targeted sessions are cost-efficient.`,
    });
  }

  // 2. Prompt style
  const avgToolRatio = sessions.reduce((sum, s) => {
    if (s.totals.userMessages === 0) return sum;
    return sum + s.totals.toolCalls / s.totals.userMessages;
  }, 0) / sessions.filter(s => s.totals.userMessages > 0).length;

  const highToolSessions = sessions.filter(s =>
    s.totals.userMessages > 0 && s.totals.toolCalls / s.totals.userMessages > 5
  );
  const highToolRate = highToolSessions.length / sessions.length;

  if (highToolRate > 0.3) {
    patterns.push({
      type: "prompt-style",
      sentiment: "negative",
      text: `${pct(highToolRate)}% of sessions have a high tool-call ratio (>5x). This usually means prompts lack specificity, causing Claude to search/read extensively.`,
    });
    recommendations.push("Include file paths, function names, or line numbers in your prompts. Instead of \"fix the bug\", try \"fix the null check in src/parser.js:45\".");
  } else if (avgToolRatio < 2) {
    patterns.push({
      type: "prompt-style",
      sentiment: "positive",
      text: `Your prompts are surgical — averaging ${avgToolRatio.toFixed(1)} tool calls per message. You give Claude enough context to act without excessive searching.`,
    });
  } else {
    patterns.push({
      type: "prompt-style",
      sentiment: "neutral",
      text: `Your tool-call ratio averages ${avgToolRatio.toFixed(1)}x per message — reasonable, with room to be more specific in some sessions.`,
    });
  }

  // 3. Cache efficiency
  const avgCache = sessions.reduce((sum, s) => sum + s.totals.cacheHitRate, 0) / sessions.length;
  if (avgCache > 0.75) {
    patterns.push({
      type: "cache-usage",
      sentiment: "positive",
      text: `Strong cache hit rate at ${pct(avgCache)}%. You're reusing context effectively, which keeps input costs low.`,
    });
  } else if (avgCache > 0.5) {
    patterns.push({
      type: "cache-usage",
      sentiment: "neutral",
      text: `Cache hit rate is ${pct(avgCache)}% — decent but could improve. Grouping related tasks in one session helps warm the cache.`,
    });
  } else {
    patterns.push({
      type: "cache-usage",
      sentiment: "negative",
      text: `Low cache hit rate at ${pct(avgCache)}%. Many tokens are being re-sent without cache reuse.`,
    });
    recommendations.push("Group related tasks in the same session so the cache stays warm. Avoid starting new sessions for quick follow-ups.");
  }

  // 4. Model usage
  const opusSessions = sessions.filter(s => (s.model || "").includes("opus"));
  const opusMismatches = sessions.filter(s => {
    return s.tips?.some(t => t.type === "model-mismatch");
  });
  if (opusMismatches.length > 2) {
    patterns.push({
      type: "model-usage",
      sentiment: "negative",
      text: `${plural(opusMismatches.length, "session")} used Opus for simple tasks that Sonnet could handle at 5x lower cost.`,
    });
    recommendations.push("Use Sonnet for quick edits, lookups, and simple bug fixes. Reserve Opus for complex refactors, architecture decisions, and multi-file changes.");
  } else if (opusSessions.length > 0) {
    patterns.push({
      type: "model-usage",
      sentiment: "positive",
      text: `You use Opus selectively (${plural(opusSessions.length, "session")}) — good model-cost awareness.`,
    });
  }

  // 5. Cost distribution
  const totalCost = sessions.reduce((sum, s) => sum + s.totals.estimatedCost, 0);
  const topSession = [...sessions].sort((a, b) => b.totals.estimatedCost - a.totals.estimatedCost)[0];
  if (topSession && totalCost > 0) {
    const topPct = (topSession.totals.estimatedCost / totalCost) * 100;
    if (topPct > 30) {
      patterns.push({
        type: "cost-distribution",
        sentiment: "negative",
        text: `Your most expensive session accounts for ${Math.round(topPct)}% of total cost ($${topSession.totals.estimatedCost.toFixed(2)}). A few heavy sessions dominate your spend.`,
      });
      recommendations.push("For your most expensive sessions, check if you could have broken the task into smaller, focused sessions or used /clear mid-session.");
    }
  }

  // Build paragraphs
  const paragraphs = [];

  // Opening line based on score
  if (overallScore >= 85) {
    paragraphs.push(`You're using Claude Code efficiently (score: ${overallScore}/100). Here's what stands out across your ${plural(sessions.length, "session")}:`);
  } else if (overallScore >= 65) {
    paragraphs.push(`Your efficiency score is ${overallScore}/100 across ${plural(sessions.length, "session")}. There are some clear opportunities to get more value from Claude Code:`);
  } else {
    paragraphs.push(`Your efficiency score is ${overallScore}/100 across ${plural(sessions.length, "session")}. A few habit changes could significantly reduce your costs and improve results:`);
  }

  // Pattern sentences grouped by sentiment
  const negativePatterns = patterns.filter(p => p.sentiment === "negative");
  const positivePatterns = patterns.filter(p => p.sentiment === "positive");
  const neutralPatterns = patterns.filter(p => p.sentiment === "neutral");

  if (positivePatterns.length > 0) {
    paragraphs.push(positivePatterns.map(p => p.text).join(" "));
  }
  if (negativePatterns.length > 0 || neutralPatterns.length > 0) {
    paragraphs.push([...negativePatterns, ...neutralPatterns].map(p => p.text).join(" "));
  }

  return { paragraphs, patterns, recommendations };
}

// --- Per-Session Summary ---

export function generateSessionSummary(session) {
  const { totals, turns, clearPoints, tips, score, dimensions, model } = session;
  const sentences = [];

  // Session type classification
  const duration = session.startTime && session.endTime
    ? (new Date(session.endTime) - new Date(session.startTime)) / 60000
    : 0;

  if (totals.userMessages <= 3) {
    sentences.push(`A quick ${plural(totals.userMessages, "message")} session.`);
  } else if (totals.userMessages <= 10) {
    sentences.push(`A focused ${plural(totals.userMessages, "message")} session${duration > 0 ? ` over ${Math.round(duration)} minutes` : ""}.`);
  } else {
    sentences.push(`A longer ${plural(totals.userMessages, "message")} session${duration > 0 ? ` spanning ${Math.round(duration)} minutes` : ""}.`);
  }

  // Cost analysis
  const costInflection = tips?.find(t => t.type === "cost-inflection");
  if (costInflection) {
    const match = costInflection.message.match(/turn (\d+)/);
    const turnNum = match ? match[1] : "?";
    sentences.push(`Cost per turn doubled around turn ${turnNum} — likely from growing context without clearing.`);
  } else if (totals.userMessages > 5) {
    sentences.push("Cost stayed stable throughout — no runaway context growth.");
  }

  // Tool efficiency
  if (totals.userMessages > 0) {
    const ratio = totals.toolCalls / totals.userMessages;
    if (ratio > 5) {
      // Find the most expensive user prompt that triggered lots of tools
      const userTurns = turns.filter(t => t.role === "user");
      const expensivePrompts = userTurns.filter(t => {
        const idx = turns.indexOf(t);
        const nextAssistant = turns.slice(idx + 1).find(a => a.role === "assistant");
        return nextAssistant && nextAssistant.toolCalls && nextAssistant.toolCalls.length > 5;
      });
      if (expensivePrompts.length > 0) {
        sentences.push(`${plural(expensivePrompts.length, "prompt")} triggered heavy tool usage (5+ calls each) — more specificity would help.`);
      } else {
        sentences.push(`High tool-call ratio (${ratio.toFixed(1)}x) — prompts could be more targeted.`);
      }
    } else if (ratio < 2) {
      sentences.push("Prompts were well-targeted with minimal tool searching.");
    }
  }

  // Cache
  if (totals.totalTokens > 50000) {
    if (totals.cacheHitRate > 0.75) {
      sentences.push(`Excellent cache reuse at ${pct(totals.cacheHitRate)}%.`);
    } else if (totals.cacheHitRate < 0.2) {
      sentences.push(`Low cache hit rate (${pct(totals.cacheHitRate)}%) — most tokens were sent fresh.`);
    }
  }

  // Model note
  const modelMismatch = tips?.find(t => t.type === "model-mismatch");
  if (modelMismatch) {
    sentences.push(`Opus was used for a simple task — Sonnet would have been 5x cheaper here.`);
  }

  // What went well
  const strengths = [];
  if (dimensions.toolRatio >= 80) strengths.push("specific prompts");
  if (dimensions.cacheHitRate >= 80) strengths.push("good cache reuse");
  if (dimensions.contextManagement >= 80) strengths.push("clean context management");
  if (dimensions.promptSpecificity >= 80) strengths.push("detailed prompts");

  if (strengths.length > 0) {
    sentences.push(`Strengths: ${strengths.join(", ")}.`);
  }

  return sentences.join(" ");
}
