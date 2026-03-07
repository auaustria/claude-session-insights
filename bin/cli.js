#!/usr/bin/env node

import { startServer } from "../src/server.js";
import { generateExport } from "../src/export.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`cc-usage-insights — Claude Code efficiency insights

Usage:
  cc-usage-insights               Open the dashboard
  cc-usage-insights export        Generate team-export.json
  cc-usage-insights --port 8080   Custom port (default: 3456)
  cc-usage-insights --no-open     Don't auto-launch browser
  cc-usage-insights --help        Show this help`);
  process.exit(0);
}

if (args[0] === "export") {
  const output = args[1] || "team-export.json";
  console.log("Parsing sessions...");
  const data = await generateExport(output);
  console.log(`Export saved to ${output}`);
  console.log(`  Score: ${data.summary.efficiencyScore}`);
  console.log(`  Sessions: ${data.summary.totalSessions}`);
  console.log(`  Tokens: ${data.summary.totalTokens.toLocaleString()}`);
  console.log(`  Badges: ${data.badges.join(", ") || "none yet"}`);
  process.exit(0);
}

// Dashboard mode
const portIdx = args.indexOf("--port");
const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3456;
const noOpen = args.includes("--no-open");

startServer(port);

if (!noOpen) {
  // Dynamic import — no hard dependency on 'open'
  try {
    const { default: open } = await import("open");
    open(`http://localhost:${port}`);
  } catch {
    console.log(`Open http://localhost:${port} in your browser`);
  }
}
