const express = require('express');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chokidar = require('chokidar');
const os = require('os');

const app = express();
const PORT = 3737;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const PRICING = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-4-8':   { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00,  cacheWrite: 1.00,  cacheRead: 0.08 },
  default:             { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
};

function getPricing(model) {
  if (!model) return PRICING.default;
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return val;
  }
  return PRICING.default;
}

function calcCost(usage, model) {
  const p = getPricing(model);
  const M = 1_000_000;
  return (
    (usage.input_tokens || 0) / M * p.input +
    (usage.output_tokens || 0) / M * p.output +
    (usage.cache_creation_input_tokens || 0) / M * p.cacheWrite +
    (usage.cache_read_input_tokens || 0) / M * p.cacheRead
  );
}

// Find the PROJECTS_DIR subfolder that matches the repo this server lives in.
// Claude Code encodes the project path by replacing every / with -.
// Walk up from __dirname until we find a matching folder in PROJECTS_DIR.
// Convert a ~/.claude/projects folder name into a readable project name.
// Folder format: absolute path with every / replaced by -, e.g. -Users-ron-Coding-Practice
function projectDisplayName(folderName) {
  const homeEncoded = os.homedir().slice(1).replace(/\//g, '-');
  let name = folderName.startsWith('-' + homeEncoded + '-')
    ? folderName.slice(homeEncoded.length + 2)
    : folderName;
  name = name.replace(/--claude-worktrees-[\w-]+$/, '');
  name = name.replace(/^Coding-Projects-/, '').replace(/^Coding-/, '');
  return name || folderName;
}

async function parseSessionFile(filePath, projectName) {
  const sessions = {};
  const daily = {};
  const seenMsgIds = new Set();
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    const msg = record.message;
    if (!msg || !msg.usage) continue;

    // Claude Code writes the same API response to multiple conversation tree nodes — deduplicate
    if (msg.id) {
      if (seenMsgIds.has(msg.id)) continue;
      seenMsgIds.add(msg.id);
    }

    const sessionId = record.sessionId || 'unknown';
    const model = msg.model || 'unknown';
    const ts = record.timestamp || null;
    const usage = msg.usage;
    const cost = calcCost(usage, model);

    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        sessionId, model, firstSeen: ts, lastSeen: ts,
        inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0,
        cacheReadTokens: 0, totalCost: 0, messageCount: 0,
        project: projectName,
      };
    }

    const s = sessions[sessionId];
    s.inputTokens += usage.input_tokens || 0;
    s.outputTokens += usage.output_tokens || 0;
    s.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    s.cacheReadTokens += usage.cache_read_input_tokens || 0;
    s.totalCost += cost;
    s.messageCount++;
    if (ts) {
      if (!s.firstSeen || ts < s.firstSeen) s.firstSeen = ts;
      if (!s.lastSeen || ts > s.lastSeen) s.lastSeen = ts;
      const date = ts.slice(0, 10);
      if (!daily[date]) daily[date] = { date, cost: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
      daily[date].cost += cost;
      daily[date].inputTokens += usage.input_tokens || 0;
      daily[date].outputTokens += usage.output_tokens || 0;
      daily[date].messages++;
    }
  }

  return { sessions: Object.values(sessions), daily };
}

async function scanAll() {
  const allSessions = [];
  const allDaily = {};
  if (!fs.existsSync(PROJECTS_DIR)) return { sessions: allSessions, daily: allDaily };

  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projPath = path.join(PROJECTS_DIR, proj);
    let files;
    try { files = fs.readdirSync(projPath); } catch { continue; }

    const projectName = projectDisplayName(proj);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const { sessions, daily } = await parseSessionFile(path.join(projPath, file), projectName);
        allSessions.push(...sessions);
        for (const [date, d] of Object.entries(daily)) {
          if (!allDaily[date]) allDaily[date] = { date, cost: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
          allDaily[date].cost += d.cost;
          allDaily[date].inputTokens += d.inputTokens;
          allDaily[date].outputTokens += d.outputTokens;
          allDaily[date].messages += d.messages;
        }
      } catch {}
    }
  }

  return { sessions: allSessions, daily: allDaily };
}

function aggregateStats(sessions, daily) {
  const totals = {
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0,
    cacheReadTokens: 0, totalCost: 0, messageCount: 0,
    sessionCount: sessions.length,
  };
  const byModel = {};
  const byProject = {};

  for (const s of sessions) {
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    totals.cacheWriteTokens += s.cacheWriteTokens;
    totals.cacheReadTokens += s.cacheReadTokens;
    totals.totalCost += s.totalCost;
    totals.messageCount += s.messageCount;

    const m = s.model || 'unknown';
    if (!byModel[m]) byModel[m] = { model: m, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalCost: 0, sessions: 0 };
    byModel[m].inputTokens += s.inputTokens;
    byModel[m].outputTokens += s.outputTokens;
    byModel[m].cacheWriteTokens += s.cacheWriteTokens;
    byModel[m].cacheReadTokens += s.cacheReadTokens;
    byModel[m].totalCost += s.totalCost;
    byModel[m].sessions++;

    const p = s.project || 'unknown';
    if (!byProject[p]) byProject[p] = { project: p, inputTokens: 0, outputTokens: 0, totalCost: 0, sessions: 0 };
    byProject[p].inputTokens += s.inputTokens;
    byProject[p].outputTokens += s.outputTokens;
    byProject[p].totalCost += s.totalCost;
    byProject[p].sessions++;
  }

  const dailyArr = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals,
    byModel: Object.values(byModel),
    byProject: Object.values(byProject).sort((a, b) => b.totalCost - a.totalCost),
    sessions,
    daily: dailyArr,
  };
}

const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch {} }
}

let lastStats = null;
let isScanning = false;

async function refresh() {
  if (isScanning) return;
  isScanning = true;
  try {
    const { sessions, daily } = await scanAll();
    lastStats = { ...aggregateStats(sessions, daily), updatedAt: new Date().toISOString() };
    broadcast({ type: 'update', ...lastStats });
  } catch (err) {
    console.error('Scan error:', err.message);
  } finally {
    isScanning = false;
  }
}

chokidar.watch(PROJECTS_DIR, {
  ignored: /[/\\]\./,
  persistent: true,
  ignoreInitial: true,
  depth: 2,
  usePolling: false,
}).on('add', () => refresh()).on('change', () => refresh());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', async (req, res) => {
  if (lastStats) return res.json(lastStats);
  const { sessions, daily } = await scanAll();
  lastStats = { ...aggregateStats(sessions, daily), updatedAt: new Date().toISOString() };
  res.json(lastStats);
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  if (lastStats) res.write(`data: ${JSON.stringify({ type: 'update', ...lastStats })}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.listen(PORT, async () => {
  console.log(`Claude Token Tracker → http://localhost:${PORT}`);
  await refresh();
});
