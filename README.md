# ⚡ Claude Live Token Tracker

A real-time dashboard that tracks your **Claude Code** token usage, estimated cost, and behavioral patterns. It reads the session files Claude Code writes locally, parses every message, and streams live updates to your browser the moment a new response lands.

![dashboard](docs/screenshot.png)

> **Note:** This runs **locally on your own machine** and shows **your own** Claude Code usage. It is not a hosted service — each person who runs it sees their own data.

---

## Features

### Live Monitoring
- **Auto-updates** — dashboard refreshes instantly every time Claude Code responds, no page reload needed
- **Live burn rate** — shows $/hr and output tokens/hr over the last 60 minutes; falls back to average $/active-hour when idle
- **Live activity feed** — scrolling log of new token events as they happen

### Cost & Usage Analytics
- **6 KPI cards** — total tokens, output tokens, cache tokens saved, all-time API cost, burn rate, plan usage
- **Daily cost chart** — selectable date ranges: 7D / 30D / 3M / 1Y / All time
- **Cost per task** — breaks down cost by individual user prompt (one prompt = one task)
- **Per-model breakdown** — cost and token split across Sonnet / Opus / Haiku
- **Per-project breakdown** — which projects consumed the most tokens and cost

### Activity Heatmap
- **Day-of-week × hour grid** — see exactly when you use Claude Code most
- Toggle between **cost** and **message count** views
- Reflects your local timezone

### Tool Usage
- **Call frequency** per tool (Bash, Edit, Read, Write, etc.)
- **Average output tokens** per tool call

### Quality Flags (configurable thresholds)
- 🚨 **Runaway outputs** — flags responses over a token threshold (default 8,000)
- 🔁 **Edit thrash** — flags files edited repeatedly in the same session (default 4×)
- 🐛 **Debug loops** — flags tasks with an unusually high tool-call count (default 8+)

All three thresholds are adjustable live with sliders — no restart needed.

---

## Requirements

- [Node.js](https://nodejs.org/) 16 or newer
- [Claude Code](https://claude.ai/code) installed and used at least once (so there's session data to read)

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/ronnie-progammer/claude-live-token-tracker.git
cd claude-live-token-tracker

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Open **http://localhost:3737** in your browser. The dashboard loads your existing history immediately and stays live from that point on.

---

## How It Works

```
Claude Code writes to → ~/.claude/projects/*.jsonl
                                  ↓
            server.js watches those files (chokidar)
                                  ↓
     parses token usage, tool calls, file edits, timestamps
                                  ↓
          aggregates tasks, heatmap, burn rate, flags
                                  ↓
        pushes update to connected browsers via SSE
                                  ↓
         index.html re-renders the live dashboard
```

### File Structure

| File | Purpose |
|------|---------|
| `server.js` | Express backend — scans JSONL session files, computes analytics, watches for changes, streams via SSE |
| `public/index.html` | Dashboard UI — Chart.js charts, heatmap, quality flags, all vanilla JS |

---

## Key Concepts

| Concept | What it is |
|---------|-----------|
| **JSONL** | JSON Lines — one JSON object per line. Claude Code appends a record to these files after every response. |
| **SSE** | Server-Sent Events — one-way real-time push from server → browser. Simpler than WebSockets for a read-only feed. |
| **chokidar** | Node.js filesystem watcher. Fires an event the moment a session file changes, triggering a rescan. |
| **Deduplication** | Claude Code writes the same API response to multiple nodes in its conversation tree. We track `message.id` to count each response exactly once. |
| **Task segmentation** | Each user prompt starts a new "task." All tokens until the next user message are attributed to that task, giving a per-prompt cost breakdown. |
| **Burn rate** | Cost of all assistant messages in the last 60 minutes, expressed as $/hr. Falls back to average $/active-hour when there's been no recent activity. |

---

## Notes & Limitations

- **Cost is an estimate** based on public Anthropic API pricing. If you're on a flat-rate plan (Pro/Max), the cost shown is what the same usage *would* cost on the raw API — not your actual bill.
- **Plan token limits are community estimates** — Anthropic does not publish exact daily caps.
- **Task detection is a heuristic** — edge cases exist in Claude Code's conversation-tree format; treat per-task costs as close estimates.
- Only reads session files currently present in `~/.claude/projects/` on this machine.

---

## License

MIT — free to use and modify.
