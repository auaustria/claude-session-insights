import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAllSessions } from "./parser.js";
import { scoreAllSessions } from "./scorer.js";
import { streamAIAnalysis, getCachedAnalysis, getAvailableModels, killActiveProcesses, detectDefaultModel } from "./ai-analyze.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8"));
const ROOT_DIR = join(__dirname, "..");
const PUBLIC_DIR = join(ROOT_DIR, "public");

let cachedData = null;
let cachedAccountInfo = null;

async function getAccountInfo() {
  if (cachedAccountInfo) return cachedAccountInfo;
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status", "--json"]);
    cachedAccountInfo = JSON.parse(stdout);
  } catch {
    cachedAccountInfo = { subscriptionType: null };
  }
  return cachedAccountInfo;
}

async function getData(forceRefresh = false) {
  if (cachedData && !forceRefresh) return cachedData;
  const sessions = await parseAllSessions();
  cachedData = scoreAllSessions(sessions);
  return cachedData;
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function startServer(port = 3456) {
  // SSE clients for live reload
  const sseClients = new Set();

  // Watch for file changes in src/ and public/
  for (const dir of ["src", "public"]) {
    watch(join(ROOT_DIR, dir), { recursive: true }, (event, filename) => {
      if (!filename) return;
      console.log(`[reload] ${dir}/${filename} changed`);
      // Bust data cache on src/ changes
      if (dir === "src") cachedData = null;
      for (const client of sseClients) {
        client.write(`data: ${dir}/${filename}\n\n`);
      }
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    try {
      // SSE endpoint for live reload
      if (url.pathname === "/api/reload") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (url.pathname === "/api/data") {
        const [data, account] = await Promise.all([getData(), getAccountInfo()]);
        // Strip turn-level detail to keep payload small
        const light = {
          overallScore: data.overallScore,
          badges: data.badges,
          tips: data.tips.slice(0, 20),
          dailyScores: data.dailyScores,
          overallSummary: data.overallSummary,
          version: pkg.version,
          account: {
            subscriptionType: account.subscriptionType || null,
            orgName: account.orgName || null,
            email: account.email || null,
          },
          sessions: data.sessions.map((s) => ({
            id: s.id,
            project: s.project,
            model: s.model,
            startTime: s.startTime,
            title: s.title,
            score: s.score,
            dimensions: s.dimensions,
            tips: s.tips,
            totals: s.totals,
            suggestedModel: s.suggestedModel,
            summary: s.summary,
          })),
        };
        return json(res, light);
      }

      // Session detail — full turn data
      const sessionMatch = url.pathname.match(/^\/api\/session\/(.+)$/);
      if (sessionMatch) {
        const data = await getData();
        const session = data.sessions.find((s) => s.id === sessionMatch[1]);
        if (!session) {
          res.writeHead(404);
          return res.end("Session not found");
        }
        return json(res, {
          id: session.id,
          project: session.project,
          model: session.model,
          startTime: session.startTime,
          endTime: session.endTime,
          title: session.title,
          score: session.score,
          dimensions: session.dimensions,
          totals: session.totals,
          clearPoints: session.clearPoints,
          suggestedModel: session.suggestedModel,
          summary: session.summary,
          turns: session.turns.map((t) => ({
            role: t.role,
            timestamp: t.timestamp,
            tokens: t.tokens,
            cost: t.cost || 0,
            toolCalls: t.toolCalls,
            model: t.model,
            promptPreview: t.promptPreview,
            textPreview: t.textPreview,
            promptLength: t.promptLength,
          })),
        });
      }

      if (url.pathname === "/api/ai-analyze" && req.method === "POST") {
        const data = await getData();
        const modelId = url.searchParams.get("model") || "";
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        streamAIAnalysis(data, res, modelId || undefined);
        return;
      }

      if (url.pathname === "/api/ai-analyze" && req.method === "GET") {
        const cached = getCachedAnalysis();
        const { models, defaultModel, defaultModelLabel } = getAvailableModels();
        return json(res, {
          ...(cached || { content: null }),
          models,
          defaultModel,
          defaultModelLabel,
        });
      }

      if (url.pathname === "/api/refresh") {
        const data = await getData(true);
        return json(res, { sessions: data.sessions.length, overallScore: data.overallScore });
      }

      // Serve static files
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const fullPath = join(PUBLIC_DIR, filePath);

      // Basic security: prevent path traversal
      if (!fullPath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }

      const ext = filePath.split(".").pop();
      const types = { html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" };

      const content = await readFile(fullPath);
      res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
      res.end(content);
    } catch (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        console.error(err);
        res.writeHead(500);
        res.end("Internal error");
      }
    }
  });

  server.listen(port, () => {
    console.log(`claude-insights running at http://localhost:${port}`);
    detectDefaultModel();
  });

  // Graceful shutdown for --watch restarts
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      killActiveProcesses();
      server.close(() => process.exit(0));
      // Force exit after 1s if connections linger
      setTimeout(() => process.exit(0), 1000);
    });
  }

  return server;
}
