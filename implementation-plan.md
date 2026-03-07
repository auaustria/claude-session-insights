# claude-insights — Project Plan

## What We're Building

A lightweight CLI tool that analyzes Claude Code session files locally, computes an efficiency score, and surfaces actionable tips. Optional team export for leads to aggregate anonymized data.

**Package name:** `claude-insights`
**Reference inspiration:** [claude-spend](https://github.com/writetoaniketparihar-collab/claude-spend) by Aniket Parihar (MIT)

### How we differ from claude-spend

claude-spend already does well: session parsing, token/cost tracking, 12 insight types, vanilla dashboard, share card. We don't need to rebuild that ground.

**Our differentiators:**
- Composite efficiency score (0-100) — a single number answer to "how efficient am I?"
- Contextual tips tied to actual session data, not generic advice
- Privacy-safe team export + aggregator pipeline
- Badges and gamification with behavioral criteria

---

## Core Decisions

- **Local-first** — all raw data stays on the developer's machine
- **Minimal dependencies** — Node.js, no framework for dashboard (plain HTML/JS)
- **No Express** — use Node's built-in `http` module for the local server (one less dep)
- **Single npm dependency: `open`** — to auto-launch browser. Everything else is stdlib.
- **No build step** — ship raw JS, no bundler, no transpiler
- **ESM modules** — use `"type": "module"` in package.json

---

## Data Source

Claude Code writes session data to `~/.claude/projects/<project-hash>/<session-id>.jsonl`

### JSONL Entry Types (from real data inspection)

| Type | Relevant | What it contains |
|---|---|---|
| `user` | Yes | User prompts, cwd, sessionId, version, gitBranch, timestamp |
| `assistant` | Yes | Model, usage (tokens), content (text + tool_use blocks), timestamp |
| `system` | Partial | Compact boundaries (useful for `/clear` detection) |
| `file-history-snapshot` | No | File backup metadata |
| `queue-operation` | No | Internal queue state |
| `progress` | No | Hook/tool progress events |

### Key fields on assistant entries
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 23990,
      "cache_read_input_tokens": 0,
      "output_tokens": 2
    },
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "name": "Read", "input": { "file_path": "..." } }
    ]
  },
  "timestamp": "2026-02-26T03:46:40.947Z"
}
```

### Project directory naming
Directories use dash-encoded absolute paths:
`-Users-archie-dev-carepatron-Carepatron-App` -> `/Users/archie/dev/carepatron/Carepatron-App`

---

## Architecture

```
~/.claude/projects/**/*.jsonl
        |
    src/parser.js      — read & structure session data
        |
    src/scorer.js      — compute efficiency score + tips + badges
        |
    src/server.js      — http server, serves API + static dashboard
        |
    src/export.js      — generate privacy-safe team JSON
        |
    public/index.html  — single-file dashboard (HTML/CSS/JS)
```

CLI entry point: `bin/cli.js`

---

## Modules

### 1. `src/parser.js` — Session Reader

Reads all `.jsonl` files from `~/.claude/projects/`, returns structured session objects.

**Per session:**
```js
{
  id: "uuid",
  project: "Carepatron-App",        // decoded from dir name
  projectPath: "/Users/.../App",    // full path
  model: "claude-opus-4-6",         // primary model (most tokens)
  startTime: Date,
  endTime: Date,
  turns: [
    {
      role: "user" | "assistant",
      timestamp: Date,
      tokens: { input, output, cacheCreation, cacheRead },
      toolCalls: ["Read", "Edit"],   // assistant only
      promptLength: 42,              // user only, char count
    }
  ],
  totals: {
    inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
    totalTokens, estimatedCost,
    toolCalls, userMessages, assistantMessages,
    cacheHitRate,                    // cacheRead / (cacheRead + cacheCreation + input)
  },
  clearPoints: [turnIndex, ...],    // where /clear or compact happened
}
```

**Pricing table (per MTok):**

| Model | Input | Output | Cache Write (1.25x) | Cache Read (0.1x) |
|---|---|---|---|---|
| opus-4-6, opus-4-5 | $15 | $75 | $18.75 | $1.50 |
| sonnet-4-6, sonnet-4-5 | $3 | $15 | $3.75 | $0.30 |
| haiku-4-5 | $0.80 | $4 | $1.00 | $0.08 |

Note: These are API-equivalent prices. Claude Code is subscription-based, but API-equivalent cost is useful as a relative efficiency metric.

### 2. `src/scorer.js` — Efficiency Engine

**Efficiency Score (0-100) — weighted composite per session:**

| Dimension | Weight | Good | Bad |
|---|---|---|---|
| Tool call ratio | 30% | < 2 calls/msg | > 5 calls/msg |
| Cache hit rate | 25% | > 60% | < 20% |
| Context management | 20% | /clear near cost inflection | never clears, runaway cost |
| Model fit | 15% | Sonnet for simple tasks | Opus for quick Q&A |
| Prompt specificity | 10% | Detailed, targeted | Short + high token blowup |

**Overall score:** weighted average across recent sessions (last 7 days default).

**Tips engine:** For each session, detect the top waste pattern and generate a specific tip.

Tip triggers:
- `toolRatio > 5` — "Session X: you sent '{prompt}' and Claude made {N} tool calls. Try specifying file paths directly."
- `cacheHitRate < 0.2` — "Session X: only {N}% cache hits. Group related tasks in one session to warm the cache."
- Cost inflection detected — "Session X: cost per turn doubled after turn {N}. Consider /clear around that point."
- Opus on simple task (< 10 msgs, < 200k tokens) — "Session X: Opus for a {N}-message chat. Sonnet handles this at 5x lower cost."

**Badges:**

| Badge | Criteria |
|---|---|
| Surgical Prompter | Tool call ratio < 2x across 5+ sessions |
| Cache Whisperer | Cache hit rate > 75% across 5+ sessions |
| Clean Slate | Uses /clear near optimal inflection in 3+ sessions |
| Model Sniper | Appropriate model selection > 90% of sessions |
| Efficiency Diamond | Overall score > 85 sustained over 7 days |

### 3. `src/export.js` — Privacy-Safe Snapshot

Generates JSON safe to share. **Never includes prompt text.**

```json
{
  "exportVersion": "1.0",
  "devId": "sha256-of-username",
  "exportDate": "2026-03-07",
  "period": { "from": "2026-02-01", "to": "2026-03-07" },
  "summary": {
    "efficiencyScore": 87,
    "totalSessions": 142,
    "totalTokens": 4820000,
    "estimatedCost": 84.50,
    "cacheHitRate": 0.71,
    "toolCallRatio": 2.1,
    "modelMix": { "sonnet": 0.82, "opus": 0.12, "haiku": 0.06 }
  },
  "dailyScores": [{ "date": "2026-03-01", "score": 82, "sessions": 5, "tokens": 340000 }],
  "topInsights": ["high-tool-ratio", "good-cache-usage"],
  "badges": ["cache-whisperer", "surgical-prompter"]
}
```

### 4. `src/server.js` — Local HTTP Server

Node `http` module (no Express). Serves:
- `GET /` — dashboard HTML
- `GET /api/data` — parsed + scored session data
- `GET /api/refresh` — re-parse from disk

### 5. `public/index.html` — Dashboard

Single HTML file with embedded CSS/JS. Shows:
- Efficiency score gauge + 7-day trend
- Badge showcase
- Session table (sortable by date, cost, score, model)
- Top tips for the week
- Daily usage bar chart (canvas)
- Model distribution breakdown

---

## CLI Commands

```bash
npx claude-insights               # open personal dashboard
npx claude-insights export        # generate team-export.json
npx claude-insights --port 8080   # custom port (default: 3456)
npx claude-insights --no-open     # don't auto-launch browser
npx claude-insights --help        # show help
```

---

## Build Order

1. **parser.js** — get data reading right, test against real sessions
2. **scorer.js** — efficiency score + tips + badges
3. **server.js + public/index.html** — local dashboard MVP
4. **export.js** — team snapshot generation
5. **bin/cli.js + package.json** — wire up CLI, test npx flow

Phase 2 (later): aggregator.js, lead dashboard, weekly wrapped

---

## Dependencies

**Runtime:** zero (Node.js stdlib only — `http`, `fs`, `path`, `readline`, `crypto`, `os`)
**Optional:** `open` (auto-launch browser — can degrade gracefully if missing)

**Dev:** none initially. Add `vitest` if/when we want tests.

---

## Privacy Principles

1. Raw prompt text never leaves the local machine
2. Export files contain only scores, counts, patterns — no content
3. Dev identity in exports is pseudonymous (hashed username)
4. Dashboard runs on localhost only

---

## File Structure

```
claude-insights/
  bin/cli.js              # entry point, arg parsing
  src/
    parser.js             # JSONL reader
    scorer.js             # efficiency engine
    server.js             # http server
    export.js             # team snapshot
  public/
    index.html            # dashboard (single file)
  package.json
  README.md
  LICENSE
  .gitignore
```

---

## Reference

- Session file format: [claude-spend](https://github.com/writetoaniketparihar-collab/claude-spend) (MIT, Aniket Parihar)
- Pricing: https://docs.anthropic.com/en/docs/about-claude/models
- Claude Code docs: https://docs.anthropic.com/en/docs/claude-code
