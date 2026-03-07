// AI-powered analysis using Claude Code CLI
// Manually triggered — streams output from `claude` via SSE.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

// Strip all Claude Code env vars so spawned claude processes don't think they're nested
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))
);

const execFileAsync = promisify(execFile);

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "sonnet" },
  { id: "claude-opus-4-6", label: "Opus 4.6", family: "opus" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku" },
];

let detectedDefaultModel = "claude-sonnet-4-6";

function prettyModelName(modelId) {
  if (!modelId) return null;
  const m = MODELS.find(m => m.id === modelId);
  if (m) return m.label;
  // Fallback: clean up the raw ID
  return modelId.replace("claude-", "").replace(/-/g, " ").replace(/(\d+) (\d+)/, "$1.$2");
}

/**
 * Detect the default model from Claude CLI config.
 * Called once at startup — non-blocking, best-effort.
 */
export async function detectDefaultModel() {
  try {
    const { stdout } = await execFileAsync("claude", ["config", "get", "model"], {
      timeout: 5000,
      env: cleanEnv,
    });
    const model = stdout.trim();
    if (model && model !== "undefined" && model !== "null") {
      detectedDefaultModel = model;
    }
  } catch {
    // Ignore — we'll detect from the first stream result instead
  }
}

function buildDataSnapshot(scoredData) {
  const { sessions, overallScore, badges, dailyScores, overallSummary } = scoredData;

  const totalCost = sessions.reduce((s, x) => s + x.totals.estimatedCost, 0);
  const totalTokens = sessions.reduce((s, x) => s + x.totals.totalTokens, 0);
  const avgCacheHit = sessions.length > 0
    ? sessions.reduce((s, x) => s + x.totals.cacheHitRate, 0) / sessions.length : 0;

  const topSessions = [...sessions]
    .sort((a, b) => b.totals.estimatedCost - a.totals.estimatedCost)
    .slice(0, 10)
    .map(s => ({
      project: s.project,
      model: s.model,
      score: s.score,
      messages: s.totals.userMessages,
      tokens: s.totals.totalTokens,
      cost: s.totals.estimatedCost.toFixed(2),
      cacheHitRate: (s.totals.cacheHitRate * 100).toFixed(0) + '%',
      toolCalls: s.totals.toolCalls,
      toolRatio: s.totals.userMessages > 0
        ? (s.totals.toolCalls / s.totals.userMessages).toFixed(1) + 'x'
        : 'n/a',
      suggestedModel: s.suggestedModel || null,
      summary: s.summary,
    }));

  const modelCounts = {};
  for (const s of sessions) {
    const m = s.model || 'unknown';
    const family = m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : 'sonnet';
    modelCounts[family] = (modelCounts[family] || 0) + 1;
  }

  return JSON.stringify({
    overview: {
      totalSessions: sessions.length,
      overallScore,
      totalCost: '$' + totalCost.toFixed(2),
      totalTokens,
      avgCacheHitRate: (avgCacheHit * 100).toFixed(0) + '%',
      badges: badges.map(b => ({ name: b.name, negative: b.negative })),
      modelDistribution: modelCounts,
    },
    dailyScores: dailyScores.slice(-14),
    topSessionsByCost: topSessions,
    staticInsights: {
      patterns: overallSummary?.patterns || [],
      recommendations: overallSummary?.recommendations || [],
    },
  }, null, 2);
}

function buildPrompt(dataSnapshot) {
  return `You are analyzing a developer's Claude Code usage data. Your job is to find non-obvious patterns and give specific, actionable advice that goes beyond the static rule-based analysis already shown to the user.

Here is their usage data:
${dataSnapshot}

Analyze this data and provide insights in the following format. Be specific — reference actual numbers, sessions, and projects. Be concise — no filler.

## Key Patterns
2-3 non-obvious patterns you notice (things the static rules might miss — e.g. time-of-day patterns, project-specific habits, cost trajectory trends, session clustering).

## Biggest Opportunities
2-3 specific workflow changes that would have the highest impact on cost or efficiency. Quantify the potential savings where possible (e.g. "switching to Sonnet for your X project sessions could save ~$Y/week").

## What's Working Well
1-2 things the user is doing right that they should keep doing.

## Standout Session
Pick the single most interesting session (most expensive, most efficient, or most unusual) and explain what makes it notable and what can be learned from it.

Keep the entire response under 400 words. Use markdown formatting.`;
}

let cachedResult = null;
const activeChildren = new Set();

/**
 * Kill all in-flight claude processes (called on server shutdown).
 */
export function killActiveProcesses() {
  for (const child of activeChildren) {
    if (child.exitCode === null) child.kill();
  }
  activeChildren.clear();
}

/**
 * Stream AI analysis to an SSE response.
 * Sends: { event: "model", data: modelId }
 *        { event: "chunk", data: text }
 *        { event: "done", data: { generatedAt } }
 *        { event: "error", data: { message } }
 */
export function streamAIAnalysis(scoredData, res, modelId) {
  const dataSnapshot = buildDataSnapshot(scoredData);
  const prompt = buildPrompt(dataSnapshot);

  const args = ["-p", "-", "--output-format", "stream-json", "--verbose"];
  if (modelId) {
    args.push("--model", modelId);
  }

  // Send the model being used
  const resolvedModel = modelId || "default";
  console.log(`[ai] Starting analysis (model: ${resolvedModel})`);
  res.write(`event: model\ndata: ${JSON.stringify(resolvedModel)}\n\n`);

  const child = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv,
  });
  activeChildren.add(child);

  // Pipe prompt via stdin to avoid CLI argument length limits
  child.stdin.write(prompt);
  child.stdin.end();

  let fullContent = "";
  let errOutput = "";
  let detectedModel = modelId || detectedDefaultModel || null;
  let lineBuf = "";

  child.stdout.on("data", (buf) => {
    lineBuf += buf.toString();
    const lines = lineBuf.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    lineBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // Skip system init and rate_limit events
        if (obj.type === "system" || obj.type === "rate_limit_event") continue;
        // Final result — extract model from modelUsage keys
        if (obj.type === "result") {
          const models = Object.keys(obj.modelUsage || {});
          if (models.length > 0) {
            detectedModel = models[0];
            if (!modelId) detectedDefaultModel = models[0];
          }
          continue;
        }
        // Assistant message — text is in message.content[]
        if (obj.type === "assistant" && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === "text" && block.text) {
              fullContent += block.text;
              res.write(`event: chunk\ndata: ${JSON.stringify(block.text)}\n\n`);
            }
          }
          // Extract model from message
          if (obj.message.model && !detectedModel) {
            detectedModel = obj.message.model;
            if (!modelId) detectedDefaultModel = obj.message.model;
          }
        }
      } catch {
        // Not JSON — treat as raw text chunk
        if (line.trim()) {
          fullContent += line;
          res.write(`event: chunk\ndata: ${JSON.stringify(line)}\n\n`);
        }
      }
    }
  });

  child.stderr.on("data", (buf) => {
    const text = buf.toString();
    errOutput += text;
    console.error(`[ai] stderr: ${text.trim()}`);
  });

  child.on("error", (err) => {
    const message = err.code === "ENOENT"
      ? "Claude CLI not found. Make sure `claude` is installed and in your PATH."
      : `Claude CLI error: ${err.message}`;
    console.error(`[ai] Process error: ${message}`);
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    res.end();
  });

  child.on("close", (code) => {
    activeChildren.delete(child);
    if (code !== 0 && !fullContent) {
      const message = errOutput.trim() || `Claude CLI exited with code ${code}`;
      console.error(`[ai] Failed (exit ${code}): ${message}`);
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    } else {
      const finalModel = detectedModel || resolvedModel;
      console.log(`[ai] Done (model: ${finalModel}, ${fullContent.length} chars)`);
      cachedResult = {
        content: fullContent.trim(),
        generatedAt: new Date().toISOString(),
        model: finalModel,
      };
      res.write(`event: done\ndata: ${JSON.stringify({ generatedAt: cachedResult.generatedAt, model: finalModel })}\n\n`);
    }
    res.end();
  });

  // Allow client disconnect to kill the process
  res.on("close", () => {
    if (child.exitCode === null) {
      console.log("[ai] Client disconnected, killing claude process");
      child.kill();
    }
  });
}

export function getCachedAnalysis() {
  return cachedResult;
}

export function clearCachedAnalysis() {
  cachedResult = null;
}

export function getAvailableModels() {
  return {
    models: MODELS,
    defaultModel: detectedDefaultModel,
    defaultModelLabel: prettyModelName(detectedDefaultModel),
  };
}
