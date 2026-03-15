// Workflow Optimizer — rule-based suggestion engine
// Analyzes session patterns and produces suggestions for skills, CLAUDE.md, agents, and plugins.

// --- Helpers ---

function computeVagueRate(sessions) {
  let total = 0;
  let vague = 0;
  for (const s of sessions) {
    const userTurns = s.turns.filter((t) => t.role === "user");
    total += userTurns.length;
    for (const turn of userTurns) {
      if (turn.promptLength < 30) {
        const idx = s.turns.indexOf(turn);
        const next = s.turns.slice(idx + 1).find((t) => t.role === "assistant");
        if (next && next.tokens.input + next.tokens.output > 50_000) vague++;
      }
    }
  }
  return total >= 5 ? vague / total : 0;
}

function computeAvgToolRatio(sessions) {
  const qualifying = sessions.filter((s) => s.totals.userMessages > 0);
  if (!qualifying.length) return 0;
  return qualifying.reduce((sum, s) => sum + s.totals.toolCalls / s.totals.userMessages, 0) / qualifying.length;
}

/**
 * Returns a map of tool name → fraction of all tool usages.
 * Only counts turns that actually have tool calls.
 */
function detectToolPatterns(sessions) {
  const counts = {};
  let total = 0;
  for (const s of sessions) {
    for (const t of s.turns) {
      for (const tool of t.toolCalls || []) {
        const name = tool.toLowerCase();
        counts[name] = (counts[name] || 0) + 1;
        total++;
      }
    }
  }
  if (!total) return {};
  const fractions = {};
  for (const [k, v] of Object.entries(counts)) fractions[k] = v / total;
  return fractions;
}

const TOPIC_PATTERNS = [
  { topic: "git", re: /\b(git|github|commit|pull request|pr|merge|branch|rebase|stash)\b/i },
  { topic: "test", re: /\b(test|spec|jest|vitest|cypress|playwright|coverage|assert)\b/i },
  { topic: "deploy", re: /\b(deploy|release|build|ci|pipeline|docker|kubernetes|k8s|heroku|vercel)\b/i },
  { topic: "debug", re: /\b(debug|fix|bug|error|crash|exception|trace|breakpoint)\b/i },
  { topic: "review", re: /\b(review|refactor|cleanup|lint|format|code review)\b/i },
  { topic: "api", re: /\b(api|endpoint|rest|graphql|backend|route|controller|service)\b/i },
  { topic: "frontend", re: /\b(ui|component|css|style|react|vue|svelte|tailwind|design)\b/i },
  { topic: "database", re: /\b(database|db|sql|query|migration|schema|postgres|mysql|sqlite|prisma|supabase)\b/i },
  { topic: "docs", re: /\b(doc|readme|documentation|comment|jsdoc|typedoc)\b/i },
];

/**
 * Groups sessions by dominant topic, returns sorted by count descending.
 */
function detectTitleClusters(sessions) {
  const counts = {};
  for (const s of sessions) {
    const title = (s.title || "") + " " + (s.project || "");
    for (const { topic, re } of TOPIC_PATTERNS) {
      if (re.test(title)) {
        counts[topic] = (counts[topic] || 0) + 1;
        break; // one topic per session
      }
    }
  }
  return Object.entries(counts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Returns sessions-per-project, sorted by count descending.
 */
function detectProjectPatterns(sessions) {
  const counts = {};
  for (const s of sessions) {
    const p = s.project || "unknown";
    counts[p] = (counts[p] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// --- Main export ---

/**
 * Generates workflow suggestions from scored session data.
 * Returns { skills, claudeMd, agents, plugins } — each an array of suggestion objects.
 */
export function generateSuggestions(scoredData) {
  const { sessions, badges } = scoredData;
  if (!sessions || sessions.length === 0) {
    return { skills: [], claudeMd: [], agents: [], plugins: [] };
  }

  const badgeIds = new Set(badges.map((b) => b.id));
  const toolPatterns = detectToolPatterns(sessions);
  const titleClusters = detectTitleClusters(sessions);
  const projectPatterns = detectProjectPatterns(sessions);
  const avgToolRatio = computeAvgToolRatio(sessions);
  const vagueRate = computeVagueRate(sessions);
  const topCluster = titleClusters[0] || null;

  const skills = [];
  const claudeMd = [];
  const agents = [];
  const plugins = [];

  // --- Skills ---

  if (badgeIds.has("vague-commander") || vagueRate > 0.2) {
    skills.push({
      id: "spec-skill",
      title: "Create a /spec planning skill",
      trigger: "/spec",
      rationale: `${Math.round(vagueRate * 100)}% of your prompts are very short and trigger expensive, wide-ranging Claude responses. A /spec skill prompts you to write a thorough task spec before Claude starts — reducing ambiguity and costly back-and-forth.`,
      priority: "high",
      templateHint:
        "Before starting any implementation task, define: what to build, constraints, files to change, what to leave alone, and success criteria. Then hand this spec to Claude.",
    });
  }

  if (badgeIds.has("context-hoarder")) {
    skills.push({
      id: "checkpoint-skill",
      title: "Create a /checkpoint context-reset skill",
      trigger: "/checkpoint",
      rationale:
        "Your sessions frequently experience cost inflection without context resets. A /checkpoint skill saves progress, summarizes state, then clears the context window — keeping sessions lean.",
      priority: "high",
      templateHint:
        "Summarize what has been accomplished so far. List remaining tasks. Note any important decisions made. Then run /clear so the next phase starts fresh with this summary.",
    });
  }

  if (avgToolRatio > 5 && !badgeIds.has("surgical-prompter")) {
    skills.push({
      id: "focus-skill",
      title: "Create a /focus task-scoping skill",
      trigger: "/focus",
      rationale: `Your average tool ratio is ${avgToolRatio.toFixed(1)}x per message — Claude spends a lot of time searching for files and context. A /focus skill primes your prompts with exact file paths and scope to eliminate unnecessary exploration.`,
      priority: "medium",
      templateHint:
        "For every task, include: exact files to change (with paths), specific line numbers if known, what NOT to modify, and the precise expected output or behavior.",
    });
  }

  if (topCluster && topCluster.count >= 5) {
    skills.push({
      id: `domain-skill-${topCluster.topic}`,
      title: `Create a /${topCluster.topic} workflow skill`,
      trigger: `/${topCluster.topic}`,
      rationale: `${topCluster.count} of your sessions involve "${topCluster.topic}" tasks. A dedicated skill standardizes how you kick off these workflows and gives Claude the right context from the start.`,
      priority: "medium",
      templateHint: `Standard workflow for ${topCluster.topic} tasks: include relevant context, patterns to follow, and any project-specific conventions.`,
    });
  }

  // --- CLAUDE.md ---

  const heavyProjects = projectPatterns.filter((p) => p.count >= 5 && p.name !== "unknown");
  for (const proj of heavyProjects.slice(0, 2)) {
    claudeMd.push({
      id: `claudemd-project-${proj.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`,
      scope: "project",
      projectName: proj.name,
      rationale: `You have ${proj.count} sessions in "${proj.name}". A CLAUDE.md file in that project gives Claude persistent context about your codebase, architecture, and conventions — reducing repeated explanations every session.`,
      priority: "high",
      sections: ["Project overview and purpose", "Key files and architecture", "Coding conventions and patterns", "Common tasks and workflows", "What NOT to do"],
    });
  }

  if (badgeIds.has("context-hoarder")) {
    claudeMd.push({
      id: "claudemd-clear-guidance",
      scope: "global",
      projectName: null,
      rationale:
        "Your sessions frequently experience cost inflection without context resets. Adding /clear guidance to your global CLAUDE.md establishes the habit of resetting context after each major task.",
      priority: "medium",
      sections: ["Context management: use /clear after completing each major task to keep sessions efficient"],
    });
  }

  if (badgeIds.has("opus-addict")) {
    claudeMd.push({
      id: "claudemd-model-guidance",
      scope: "global",
      projectName: null,
      rationale:
        "You frequently use Opus for tasks where Sonnet performs equally well. Documenting model selection guidelines in CLAUDE.md (or setting a default model via claude config) could significantly reduce cost.",
      priority: "high",
      sections: ["Model selection: default to Sonnet for routine coding tasks, use Opus only for complex architecture decisions or deep reasoning"],
    });
  }

  if (avgToolRatio > 5 && !badgeIds.has("surgical-prompter")) {
    claudeMd.push({
      id: "claudemd-prompt-conventions",
      scope: "global",
      projectName: null,
      rationale:
        "Your high tool-call ratio suggests Claude frequently has to search for context you could provide upfront. Adding prompt conventions to your CLAUDE.md establishes expectations for how specific your prompts should be.",
      priority: "medium",
      sections: ["Prompt conventions: always include exact file paths, avoid vague references like 'the function' or 'that thing'"],
    });
  }

  // --- Agents ---

  const highToolSessions = sessions.filter(
    (s) => s.totals.toolCalls > 20 && s.totals.userMessages > 0
  );
  if (highToolSessions.length >= 3) {
    agents.push({
      id: "explore-agent",
      name: "Explore subagent",
      use_case: "Offload codebase exploration and file discovery",
      rationale: `${highToolSessions.length} of your sessions use 20+ tool calls for file searches and codebase navigation. An Explore subagent handles this research in parallel and in a clean context, keeping your main session focused.`,
      priority: "medium",
      example:
        'Launch with: Agent tool with subagent_type="Explore", prompt="Find all files related to authentication and explain the flow"',
    });
  }

  if (topCluster && topCluster.count >= 8) {
    agents.push({
      id: `specialist-agent-${topCluster.topic}`,
      name: `${topCluster.topic} specialist agent`,
      use_case: `Handle ${topCluster.topic} tasks autonomously from a single high-level prompt`,
      rationale: `You have ${topCluster.count} sessions focused on "${topCluster.topic}". A specialist subagent for this workflow could handle the entire task from a single high-level instruction, with expertise baked in.`,
      priority: "low",
      example: `Create a custom agent type optimized for ${topCluster.topic} tasks with relevant tools and context pre-loaded.`,
    });
  }

  // --- Plugins ---
  // Note: MCP servers load all their tool definitions into context on every message,
  // adding token overhead even when unused. Only recommend MCPs where they provide
  // a genuine capability gap over CLI tools (i.e., Bash can't do it well).

  const bashFraction = toolPatterns["bash"] || 0;
  const webSessions = sessions.filter((s) =>
    /browser|playwright|scrape|screenshot|e2e|visual test/i.test(s.title)
  );
  if (bashFraction > 0.3 && webSessions.length >= 3) {
    plugins.push({
      id: "playwright-mcp",
      name: "Playwright MCP",
      rationale: `${webSessions.length} sessions involve browser tasks that curl/bash can't handle well — screenshots, JS-rendered pages, user interaction flows. Playwright MCP is one of the few cases where an MCP genuinely beats the CLI alternative.`,
      installCmd: "claude mcp add playwright npx @playwright/mcp@latest",
      url: "https://github.com/microsoft/playwright-mcp",
      priority: "medium",
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const byPriority = (a, b) =>
    (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);

  return {
    skills: skills.sort(byPriority),
    claudeMd: claudeMd.sort(byPriority),
    agents: agents.sort(byPriority),
    plugins: plugins.sort(byPriority),
  };
}
