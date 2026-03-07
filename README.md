# claude-insights

A lightweight CLI tool that analyzes your Claude Code sessions locally, computes an efficiency score, and surfaces actionable insights to help you use Claude more effectively.

Think "Spotify Wrapped" for your Claude Code usage — scores, summaries, badges, cost breakdowns, and a local dashboard. All data stays on your machine.

## Features

- **Efficiency Score (0-100)** — weighted composite across 5 dimensions: tool call ratio, cache hit rate, context management, model fit, and prompt specificity
- **Overall Summary** — natural-language assessment of your prompting habits with specific recommendations ("31% of sessions have high tool-call ratios — include file paths and function names to reduce searching")
- **Per-Session Summary** — each session gets a plain-English breakdown of what happened, what went well, and what could improve
- **Session Drill-down** — click any session to see the full conversation timeline with per-turn token counts, costs, tool calls, and prompt previews
- **Badges** — behavioral achievements like Surgical Prompter, Cache Whisperer, and Efficiency Diamond

## Quick Start

```bash
npx claude-insights
```

That's it. Opens a dashboard at `http://localhost:3456` showing all your Claude Code sessions.

## Commands

```bash
npx claude-insights                # open the dashboard
npx claude-insights export         # generate team-export.json
npx claude-insights --port 8080    # custom port (default: 3456)
npx claude-insights --no-open      # don't auto-launch browser
npx claude-insights --help         # show help
```

## What It Reads

Claude Code stores session data in `~/.claude/projects/`. This tool reads those JSONL files to extract:

- Token counts (input, output, cache creation, cache read)
- Models used per turn
- Tool calls (Read, Edit, Bash, etc.)
- Timestamps and session structure
- Prompt text (displayed locally only, never exported)

Works with sessions from the terminal CLI, VS Code extension, and Claude Desktop (Code tab) — they all write to the same `~/.claude/` directory.

## Efficiency Score

Each session is scored 0-100 across five dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| Tool Call Ratio | 30% | Fewer tool calls per message = more specific prompts |
| Cache Hit Rate | 25% | Higher cache reuse = better session structure |
| Context Management | 20% | Using /clear near cost inflection points |
| Model Fit | 15% | Right model for the task complexity |
| Prompt Specificity | 10% | Short vague prompts that cause token blowups |

Your overall score is the weighted average across sessions from the last 7 days.

## Summaries

The dashboard generates rule-based summaries at two levels:

**Overall** — analyzes patterns across all your sessions: session length habits, prompt specificity, cache efficiency, model selection, and cost distribution. Surfaces 2-3 key findings and concrete recommendations.

**Per-session** — classifies each session (quick fix, focused task, long refactor), identifies the main cost driver, and highlights strengths. Displayed at the top of the session detail view.

## Badges

| Badge | Criteria |
|---|---|
| Surgical Prompter | Tool call ratio < 2x across 5+ sessions |
| Cache Whisperer | Cache hit rate > 75% across 5+ sessions |
| Clean Slate | Uses /clear near cost inflection in 3+ sessions |
| Model Sniper | Appropriate model selection > 90% of sessions |
| Efficiency Diamond | Overall score > 85 sustained over 7 days |

## Team Export

Generate a privacy-safe snapshot to share with your team lead:

```bash
npx claude-insights export
```

The export contains scores, token counts, cost breakdowns, badge status, and summary categories — **never prompt text**. Team leads can aggregate these to identify coaching opportunities across the team.

## Dependencies

**Zero runtime dependencies.** Uses only Node.js built-in modules (`http`, `fs`, `readline`, `crypto`, `os`, `path`).

## Privacy

- All data processing happens locally on your machine
- The dashboard runs on localhost only
- Prompt text is displayed in the local dashboard but never included in exports
- Team exports contain only aggregate scores, counts, and pattern categories

## Inspiration

Built from scratch, inspired by [claude-spend](https://github.com/writetoaniketparihar-collab/claude-spend) by Aniket Parihar (MIT). We share the same data source but take a different approach: efficiency scoring, team workflows, and behavioral gamification.

## License

MIT
