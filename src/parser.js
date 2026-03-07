import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// API-equivalent pricing per million tokens
const PRICING = {
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
};

const DEFAULT_PRICING = { input: 3, output: 15 }; // fallback to sonnet-tier
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function getModelPricing(model) {
  if (!model) return DEFAULT_PRICING;
  return PRICING[model] ?? DEFAULT_PRICING;
}

function computeTurnCost(tokens, model) {
  const p = getModelPricing(model);
  const m = 1_000_000;
  return (
    (tokens.input * p.input) / m +
    (tokens.cacheCreation * p.input * CACHE_WRITE_MULTIPLIER) / m +
    (tokens.cacheRead * p.input * CACHE_READ_MULTIPLIER) / m +
    (tokens.output * p.output) / m
  );
}

// "-Users-archie-dev-carepatron-App" -> { name: "App", path: "/Users/archie/dev/carepatron/App" }
function decodeProjectDir(dirName) {
  // Leading dash + split by dash, reconstruct as path
  const fullPath = dirName.startsWith("-")
    ? "/" + dirName.slice(1).replace(/-/g, "/")
    : dirName.replace(/-/g, "/");
  const name = fullPath.split("/").pop() || dirName;
  return { name, path: fullPath };
}

async function parseSessionFile(filePath) {
  const turns = [];
  const clearPoints = [];
  const modelCounts = {};
  let turnIndex = 0;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "user" && entry.message?.role === "user") {
      const content = entry.message.content;
      // Detect /clear commands
      if (typeof content === "string" && content.includes("<command-name>/clear</command-name>")) {
        clearPoints.push(turnIndex);
      }
      // Extract raw text for preview
      let rawText = "";
      if (typeof content === "string") {
        rawText = content;
      } else if (Array.isArray(content)) {
        rawText = content.map((c) => c.text || "").join(" ");
      }

      // Strip XML tags (command wrappers, system reminders, etc.)
      const cleanText = rawText
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const promptLength = cleanText.length;

      // Skip meta messages (system-generated)
      if (entry.isMeta) continue;
      // Skip empty/system-only messages
      if (promptLength === 0) continue;

      turns.push({
        role: "user",
        timestamp: entry.timestamp,
        tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        toolCalls: [],
        promptLength,
        promptPreview: cleanText.slice(0, 300),
      });
      turnIndex++;
    } else if (entry.type === "assistant" && entry.message) {
      const msg = entry.message;
      const usage = msg.usage;
      if (!usage) continue;

      const model = msg.model || null;
      if (model) {
        modelCounts[model] = (modelCounts[model] || 0) + (usage.output_tokens || 0);
      }

      const contentBlocks = msg.content || [];
      const toolCalls = contentBlocks
        .filter((c) => c.type === "tool_use")
        .map((c) => c.name);

      const textPreview = contentBlocks
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);

      const tokens = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
      };

      turns.push({
        role: "assistant",
        timestamp: entry.timestamp,
        tokens,
        toolCalls,
        model,
        cost: computeTurnCost(tokens, model),
        textPreview,
      });
      turnIndex++;
    } else if (entry.type === "system" && entry.subtype === "compact_boundary") {
      clearPoints.push(turnIndex);
    }
  }

  return { turns, clearPoints, modelCounts };
}

function computeSessionTotals(turns) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let toolCalls = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let estimatedCost = 0;

  for (const turn of turns) {
    if (turn.role === "user") {
      userMessages++;
    } else {
      assistantMessages++;
      inputTokens += turn.tokens.input;
      outputTokens += turn.tokens.output;
      cacheCreationTokens += turn.tokens.cacheCreation;
      cacheReadTokens += turn.tokens.cacheRead;
      toolCalls += turn.toolCalls.length;
      estimatedCost += turn.cost || 0;
    }
  }

  const totalInput = inputTokens + cacheCreationTokens + cacheReadTokens;
  const cacheHitRate = totalInput > 0 ? cacheReadTokens / totalInput : 0;

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: totalInput + outputTokens,
    estimatedCost,
    toolCalls,
    userMessages,
    assistantMessages,
    cacheHitRate,
  };
}

function primaryModel(modelCounts) {
  let best = null;
  let max = 0;
  for (const [model, count] of Object.entries(modelCounts)) {
    if (count > max) {
      best = model;
      max = count;
    }
  }
  return best;
}

export async function parseAllSessions(claudeDir) {
  const projectsDir = join(claudeDir || join(homedir(), ".claude"), "projects");
  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const sessions = [];

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    const { name: projectName, path: projectPath } = decodeProjectDir(projDir);

    let files;
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projPath, file);
      const sessionId = basename(file, ".jsonl");

      try {
        const { turns, clearPoints, modelCounts } = await parseSessionFile(filePath);

        // Skip empty sessions
        const assistantTurns = turns.filter((t) => t.role === "assistant");
        if (assistantTurns.length === 0) continue;

        const totals = computeSessionTotals(turns);
        const timestamps = turns.map((t) => t.timestamp).filter(Boolean);
        const firstUserTurn = turns.find((t) => t.role === "user");
        const title = firstUserTurn?.promptPreview?.slice(0, 120) || "Untitled session";

        sessions.push({
          id: sessionId,
          project: projectName,
          projectPath,
          model: primaryModel(modelCounts),
          startTime: timestamps[0] || null,
          endTime: timestamps[timestamps.length - 1] || null,
          title,
          turns,
          totals,
          clearPoints,
        });
      } catch {
        // Skip unreadable files
        continue;
      }
    }
  }

  // Sort by start time, newest first
  sessions.sort((a, b) => {
    if (!a.startTime || !b.startTime) return 0;
    return new Date(b.startTime) - new Date(a.startTime);
  });

  return sessions;
}
