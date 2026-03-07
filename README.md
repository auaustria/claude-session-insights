# claude-insights

A lightweight CLI tool that analyzes your Claude Code sessions locally, computes an efficiency score, and surfaces actionable insights to help you use Claude more effectively.

Think "Spotify Wrapped" for your Claude Code usage — scores, summaries, badges, cost breakdowns, AI-powered analysis, and a local dashboard. All data stays on your machine.

## Features

- **Efficiency Score (0-100)** — weighted composite across 5 dimensions: tool call ratio, cache hit rate, context management, model fit, and prompt specificity
- **Overall Summary** — natural-language assessment of your prompting habits with specific recommendations
- **Per-Session Summary** — each session gets a plain-English breakdown of what happened, what went well, and what could improve
- **Session Drill-down** — click any session to see the full conversation timeline with per-turn token counts, costs, tool calls, and prompt previews
- **AI Insights** — on-demand deeper analysis powered by the Claude CLI, with model picker (Sonnet, Opus, Haiku) and streaming output
- **Heaviest Sessions** — top sessions ranked by cost for quick identification of expensive outliers
- **Daily Score Chart** — trend visualization of your efficiency score, session count, tokens, and cost over time
- **Badges** — positive achievements (Surgical Prompter, Cache Whisperer, etc.) and negative anti-patterns (Opus Addict, Token Furnace, etc.)
- **Light/Dark Theme** — toggleable with automatic system preference detection
- **Auto-Refresh** — optional 15-second polling to keep the dashboard current while you work
- **Account Info** — displays your subscription type, org, and email from `claude auth status`

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

## AI Insights

Click "Generate AI Insights" to run a deeper analysis using the Claude CLI. This streams a response via SSE that covers:

- **Key Patterns** — non-obvious trends the static rules miss (time-of-day patterns, project-specific habits, cost trajectories)
- **Biggest Opportunities** — specific workflow changes with quantified potential savings
- **What's Working Well** — habits worth keeping
- **Standout Session** — the most interesting session and what can be learned from it

You can pick which model to use (Sonnet, Opus, or Haiku) from the model picker. Results are cached for the session. Requires the `claude` CLI to be installed and in your PATH.

## Badges

### Positive

| Badge | Criteria |
|---|---|
| Surgical Prompter | Tool call ratio < 2x across 5+ sessions |
| Cache Whisperer | Cache hit rate > 75% across 5+ sessions |
| Clean Slate | Uses /clear near cost inflection in 3+ sessions |
| Model Sniper | Appropriate model selection > 90% of sessions |
| Efficiency Diamond | Overall score > 85 sustained over 7 days |

### Negative

| Badge | Criteria |
|---|---|
| Opus Addict | >70% of sessions use Opus when Sonnet would suffice |
| Token Furnace | Average cost per user message > $0.50 across 5+ sessions |
| Context Hoarder | Cost inflection without /clear in 50%+ of long sessions |
| Vague Commander | >30% of prompts are vague and trigger expensive responses |

## Team Export

Generate a privacy-safe snapshot to share with your team lead:

```bash
npx claude-insights export
```

The export contains scores, token counts, cost breakdowns, badge status, and summary categories — **never prompt text**. Team leads can aggregate these to identify coaching opportunities across the team.

## Supported Models

Pricing is built in for:

- Claude Opus 4.5 / 4.6
- Claude Sonnet 4.5 / 4.6
- Claude Haiku 4.5

Unknown models fall back to Sonnet-tier pricing.

## Development

```bash
npm run dev    # starts server with --watch on src/ and public/, live reloads on changes
```

## Dependencies

**Zero runtime dependencies.** Uses only Node.js built-in modules (`http`, `fs`, `readline`, `crypto`, `os`, `path`). The `open` package is optionally used to launch the browser but is not required — if unavailable, the URL is printed instead.

AI Insights requires the [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) to be installed.

## Privacy

- All data processing happens locally on your machine
- The dashboard runs on localhost only
- Prompt text is displayed in the local dashboard but never included in exports
- Team exports contain only aggregate scores, counts, and pattern categories
- AI Insights sends a data snapshot (scores, token counts, costs — no prompt text) to the Claude CLI for analysis

## Inspiration

Built from scratch, inspired by [claude-spend](https://github.com/writetoaniketparihar-collab/claude-spend) by Aniket Parihar (MIT). We share the same data source but take a different approach: efficiency scoring, team workflows, and behavioral gamification.

## License

MIT
