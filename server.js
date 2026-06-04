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

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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

const emptyHeatmap = () => Array.from({ length: 7 }, () => new Array(24).fill(0));

// Pull readable text out of a user message; '' if it's a tool result / non-text.
function userPromptText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    const texts = c.filter(b => b && b.type === 'text').map(b => b.text || '');
    return texts.join(' ').trim();
  }
  return '';
}

// A "real" user prompt = a typed message, not a tool_result and not a system-injected block.
function isUserPrompt(record) {
  const msg = record.message;
  if (!msg || msg.role !== 'user') return false;
  if (record.isSidechain || record.isMeta) return false;
  const text = userPromptText(msg);
  if (!text) return false;
  // Skip slash-command wrappers and harness-injected blocks
  if (/^<(command|local-command|user-prompt-submit)/i.test(text)) return false;
  if (/^Caveat: The messages below/i.test(text)) return false;
  return true;
}

async function parseSessionFile(filePath, projectName) {
  const sessions = {};
  const daily = {};
  const tasks = [];
  const messages = [];          // assistant messages: { sid, project, ts, out, cost }
  const toolCounts = {};        // name -> { count, outTokens }
  const fileEdits = {};         // `${sid}::${file}` -> { sid, project, file, edits }
  const heatmapCost = emptyHeatmap();
  const heatmapMsgs = emptyHeatmap();
  const seenMsgIds = new Set();
  const seenPrompts = new Set();

  let currentTask = null;
  const closeTask = () => {
    if (currentTask && (currentTask.cost > 0 || currentTask.toolCalls > 0)) tasks.push(currentTask);
    currentTask = null;
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    const sessionId = record.sessionId || 'unknown';
    const ts = record.timestamp || null;

    // ── User prompt → starts a new task ──────────────────────────────────────
    if (isUserPrompt(record)) {
      const text = userPromptText(record.message);
      const key = sessionId + '::' + text.slice(0, 120);
      if (seenPrompts.has(key)) continue; // dedup branch-duplicated prompts
      seenPrompts.add(key);
      closeTask();
      currentTask = {
        sid: sessionId, project: projectName, ts,
        promptPreview: text.replace(/\s+/g, ' ').slice(0, 90),
        cost: 0, inputTokens: 0, outputTokens: 0,
        toolCalls: 0, assistantTurns: 0, endTs: ts,
      };
      continue;
    }

    // ── Assistant message with usage ─────────────────────────────────────────
    const msg = record.message;
    if (!msg || !msg.usage) continue;
    if (msg.id) {
      if (seenMsgIds.has(msg.id)) continue; // dedup branch-duplicated responses
      seenMsgIds.add(msg.id);
    }

    const model = msg.model || 'unknown';
    const usage = msg.usage;
    const out = usage.output_tokens || 0;
    const cost = calcCost(usage, model);

    // Session rollup
    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        sessionId, model, firstSeen: ts, lastSeen: ts,
        inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0,
        cacheReadTokens: 0, totalCost: 0, messageCount: 0, project: projectName,
      };
    }
    const s = sessions[sessionId];
    s.inputTokens += usage.input_tokens || 0;
    s.outputTokens += out;
    s.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    s.cacheReadTokens += usage.cache_read_input_tokens || 0;
    s.totalCost += cost;
    s.messageCount++;

    // Tool calls in this assistant message
    const toolUses = Array.isArray(msg.content)
      ? msg.content.filter(b => b && b.type === 'tool_use')
      : [];
    const nTools = toolUses.length;
    const perToolOut = nTools ? out / nTools : 0;
    for (const tu of toolUses) {
      const name = tu.name || 'unknown';
      if (!toolCounts[name]) toolCounts[name] = { count: 0, outTokens: 0 };
      toolCounts[name].count++;
      toolCounts[name].outTokens += perToolOut;

      if (EDIT_TOOLS.has(name)) {
        const file = (tu.input && (tu.input.file_path || tu.input.notebook_path)) || 'unknown';
        const fk = sessionId + '::' + file;
        if (!fileEdits[fk]) fileEdits[fk] = { sid: sessionId, project: projectName, file, edits: 0 };
        fileEdits[fk].edits++;
      }
    }

    // Per-message record (runaway detection + live burn rate)
    messages.push({ sid: sessionId, project: projectName, ts, out, cost, tools: nTools });

    // Attach to the open task
    if (currentTask) {
      currentTask.cost += cost;
      currentTask.inputTokens += usage.input_tokens || 0;
      currentTask.outputTokens += out;
      currentTask.toolCalls += nTools;
      currentTask.assistantTurns++;
      if (ts) currentTask.endTs = ts;
    }

    // Time series + heatmaps
    if (ts) {
      if (!s.firstSeen || ts < s.firstSeen) s.firstSeen = ts;
      if (!s.lastSeen || ts > s.lastSeen) s.lastSeen = ts;
      const date = ts.slice(0, 10);
      if (!daily[date]) daily[date] = { date, cost: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
      daily[date].cost += cost;
      daily[date].inputTokens += usage.input_tokens || 0;
      daily[date].outputTokens += out;
      daily[date].messages++;

      const d = new Date(ts);            // local time of this machine
      const dow = d.getDay(), hr = d.getHours();
      heatmapCost[dow][hr] += cost;
      heatmapMsgs[dow][hr] += 1;
    }
  }
  closeTask();

  return { sessions: Object.values(sessions), daily, tasks, messages, toolCounts, fileEdits, heatmapCost, heatmapMsgs };
}

function mergeHeatmap(target, src) {
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) target[d][h] += src[d][h];
}

async function scanAll() {
  const all = {
    sessions: [], daily: {}, tasks: [], messages: [],
    toolCounts: {}, fileEdits: {},
    heatmapCost: emptyHeatmap(), heatmapMsgs: emptyHeatmap(),
  };
  if (!fs.existsSync(PROJECTS_DIR)) return all;

  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projPath = path.join(PROJECTS_DIR, proj);
    let files;
    try { files = fs.readdirSync(projPath); } catch { continue; }
    const projectName = projectDisplayName(proj);

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const r = await parseSessionFile(path.join(projPath, file), projectName);
        all.sessions.push(...r.sessions);
        all.tasks.push(...r.tasks);
        all.messages.push(...r.messages);
        for (const [date, d] of Object.entries(r.daily)) {
          if (!all.daily[date]) all.daily[date] = { date, cost: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
          all.daily[date].cost += d.cost;
          all.daily[date].inputTokens += d.inputTokens;
          all.daily[date].outputTokens += d.outputTokens;
          all.daily[date].messages += d.messages;
        }
        for (const [name, t] of Object.entries(r.toolCounts)) {
          if (!all.toolCounts[name]) all.toolCounts[name] = { count: 0, outTokens: 0 };
          all.toolCounts[name].count += t.count;
          all.toolCounts[name].outTokens += t.outTokens;
        }
        for (const [fk, fe] of Object.entries(r.fileEdits)) {
          if (!all.fileEdits[fk]) all.fileEdits[fk] = { ...fe, edits: 0 };
          all.fileEdits[fk].edits += fe.edits;
        }
        mergeHeatmap(all.heatmapCost, r.heatmapCost);
        mergeHeatmap(all.heatmapMsgs, r.heatmapMsgs);
      } catch {}
    }
  }
  return all;
}

function aggregateStats(scan) {
  const { sessions, daily, tasks, messages, toolCounts, fileEdits, heatmapCost, heatmapMsgs } = scan;

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

  const byTool = Object.entries(toolCounts)
    .map(([tool, t]) => ({ tool, count: t.count, avgOutputTokens: t.count ? Math.round(t.outTokens / t.count) : 0 }))
    .sort((a, b) => b.count - a.count);

  // Top tasks by cost (keep payload reasonable)
  const topTasks = tasks.slice().sort((a, b) => b.cost - a.cost).slice(0, 100);

  // File edits worth sending (>= 2 so the thrash slider can go as low as 2)
  const editList = Object.values(fileEdits)
    .filter(f => f.edits >= 2)
    .sort((a, b) => b.edits - a.edits)
    .slice(0, 100);

  const dailyArr = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals,
    byModel: Object.values(byModel),
    byProject: Object.values(byProject).sort((a, b) => b.totalCost - a.totalCost),
    byTool,
    sessions,
    daily: dailyArr,
    tasks: topTasks,
    taskCount: tasks.length,
    messages,
    fileEdits: editList,
    heatmap: { cost: heatmapCost, messages: heatmapMsgs },
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
    const scan = await scanAll();
    lastStats = { ...aggregateStats(scan), updatedAt: new Date().toISOString() };
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
  const scan = await scanAll();
  lastStats = { ...aggregateStats(scan), updatedAt: new Date().toISOString() };
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
