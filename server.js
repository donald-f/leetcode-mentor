'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const OpenAI = require('openai');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PREFERRED_LANGUAGES = (process.env.PREFERRED_LANGUAGES || 'C#, JavaScript')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Session signing secret. Stateless: any instance with the same env vars can
// verify cookies, so the app survives Railway sleep/restart with no store.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`lcm:${APP_PASSWORD}`).digest('hex');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'lcm_session';

const MODELS = {
  'gpt-4o-mini': { label: 'GPT-4o mini', note: 'cheap default' },
  'gpt-4o': { label: 'GPT-4o', note: 'stronger' },
};
const DEFAULT_MODEL = 'gpt-4o-mini';

if (!OPENAI_API_KEY) console.warn('[warn] OPENAI_API_KEY is not set — chat requests will fail.');
if (!APP_PASSWORD) console.warn('[warn] APP_PASSWORD is not set — login will reject everyone.');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(mode) {
  const langPrimary = PREFERRED_LANGUAGES[0] || 'C#';
  const langList = PREFERRED_LANGUAGES.join(', ') || 'C#, JavaScript';

  const base = `You are LeetCode Mentor, an expert algorithms and data-structures coach helping a developer prepare for technical interviews. You are rigorous, encouraging, and treat the user as a capable engineer.

## Universal rules (apply in every mode)
- Before giving substantive help on a problem, ask what the user has already tried and what their current thinking is — unless they have already explained it in this conversation. One short check-in question is enough; do not interrogate.
- Frame guidance in terms of named patterns first (two pointers, sliding window, prefix sums, binary search on answer, BFS/DFS, topological sort, dynamic programming, greedy + exchange argument, heap / priority queue, monotonic stack, union-find, backtracking, bitmasking, etc.) before getting problem-specific.
- Always discuss time and space complexity when an approach or solution is on the table, and name the input variables (e.g. O(n log n) where n = array length).
- Preferred languages: ${langList}. Write code in ${langPrimary} by default; use another listed language if the user's pasted code is in it or they ask.
- Use markdown. Put all code in fenced blocks with a language tag. Keep code idiomatic and interview-realistic (no exotic library tricks).
- If the user pastes a problem statement, briefly restate the core task in one sentence to confirm understanding before coaching.
- When the user is wrong, say so plainly and explain why with a concrete counterexample or failing input when possible.
- Mention relevant edge cases (empty input, single element, duplicates, overflow, negative numbers, ties) when they matter.
- Stay on topic: algorithms, data structures, complexity, interview technique. Politely decline unrelated requests.

## Solution review requests
When a message begins with [REVIEW MY SOLUTION], critique the submitted code regardless of mode:
1. **Correctness** — does it solve the problem? Identify bugs with a concrete failing input if any exist.
2. **Complexity** — time and space, and whether an asymptotically better approach exists (in Socratic/Hint modes, name the better pattern but do not write the better solution unless asked).
3. **Edge cases** — which are handled, which are missed.
4. **Readability & style** — naming, structure, idiomatic use of the language.
5. **Interview follow-ups** — list 2–4 classic variations an interviewer would ask next for this problem (e.g. "what if the input doesn't fit in memory?", "what if it's streaming?", "can you do it in O(1) space?").`;

  const modes = {
    socratic: `## Current mode: Socratic mentor
- NEVER reveal the solution, the key algorithmic insight, or solution code unless the user explicitly asks for it (e.g. "just tell me", "show me the solution"). If they ask explicitly, comply — but first offer one last nudge: "Want one more hint instead?" only once, then respect their choice.
- Lead with guiding questions: ask the user to explain their approach, probe assumptions, point at the part of their reasoning that breaks, and suggest small concrete experiments ("trace your algorithm on [3,1,2] — what happens at i=1?").
- Ask at most 1–2 questions per reply so the conversation stays focused.
- Affirm correct reasoning explicitly so the user knows which parts of their thinking to keep.
- You may name a pattern family as a nudge ("this smells like a sliding-window problem — why might that fit?") but do not explain how to apply it until the user has wrestled with it.`,

    hints: `## Current mode: Hint ladder
- Give progressively stronger hints, exactly ONE level per request. Never give the next hint until the user explicitly asks for it ("next hint", "another hint", etc.).
- Label every hint clearly: "**Hint 1**", "**Hint 2**", ... Track the ladder across the conversation and never repeat or skip levels.
- Ladder shape: Hint 1 names the pattern family or a reframing of the problem; middle hints narrow to the key insight or invariant; the final hint is essentially the approach in words (still no code).
- After each hint, stop. Briefly invite the user to try again with it ("Take another swing with that — or ask for Hint ${'{'}n+1{'}'}.").
- Only produce solution code if the user explicitly asks for the full solution; then switch into a full walkthrough with complexity analysis.`,

    solution: `## Current mode: Full solution
- Walk through the optimal solution step by step:
  1. Restate the problem and identify the pattern.
  2. Build the intuition — why this pattern, what invariant makes it work, why naive approaches fall short.
  3. Present clean, well-commented code in the preferred language.
  4. State time and space complexity with brief justification.
  5. Walk through one small example input end to end.
- Then ask 1–2 follow-up questions to check the user's understanding (e.g. "why does the window never need to shrink past left?", "what changes if the array can contain negatives?"). Wait for their answers and give feedback on them.`,
  };

  return `${base}\n\n${modes[mode] || modes.socratic}`;
}

// ---------------------------------------------------------------------------
// Auth: HMAC-signed expiry cookie, no server-side session store
// ---------------------------------------------------------------------------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeSessionToken() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function requireAuth(req, res, next) {
  if (verifySessionToken(parseCookies(req)[COOKIE_NAME])) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS at the proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

app.post('/api/login', (req, res) => {
  const supplied = String(req.body?.password ?? '');
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!APP_PASSWORD || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', sessionCookie(req, makeSessionToken(), SESSION_TTL_MS / 1000));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, note: m.note })),
    defaultModel: DEFAULT_MODEL,
    preferredLanguages: PREFERRED_LANGUAGES,
  });
});

// Trim history so a long conversation can't blow up the token budget.
function trimMessages(messages) {
  const MAX_MESSAGES = 40;
  const MAX_CHARS_PER_MESSAGE = 60_000;
  const MAX_TOTAL_CHARS = 200_000;

  let trimmed = messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? '').slice(0, MAX_CHARS_PER_MESSAGE),
  }));

  let total = trimmed.reduce((n, m) => n + m.content.length, 0);
  while (total > MAX_TOTAL_CHARS && trimmed.length > 1) {
    total -= trimmed[0].content.length;
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function friendlyOpenAIError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return 'OpenAI rate limit hit (or quota exhausted). Wait a moment and try again.';
  if (status === 401) return 'OpenAI rejected the API key. Check OPENAI_API_KEY on the server.';
  if (status === 400) return `OpenAI rejected the request: ${err?.message || 'bad request'}`;
  if (status >= 500) return 'OpenAI is having trouble right now. Try again shortly.';
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT') {
    return 'Could not reach OpenAI (network error). Try again.';
  }
  return `Request failed: ${err?.message || 'unknown error'}`;
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, mode, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const chosenModel = MODELS[model] ? model : DEFAULT_MODEL;
  const chosenMode = ['socratic', 'hints', 'solution'].includes(mode) ? mode : 'socratic';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const abort = new AbortController();
  // res 'close' fires on client disconnect; writableEnded distinguishes that
  // from normal completion. (req 'close' fires as soon as the body is read.)
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    const stream = await openai.chat.completions.create(
      {
        model: chosenModel,
        stream: true,
        messages: [
          { role: 'system', content: buildSystemPrompt(chosenMode) },
          ...trimMessages(messages),
        ],
      },
      { signal: abort.signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) send({ content: delta });
    }
    send({ done: true, model: chosenModel });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('[chat error]', err?.status || '', err?.message);
      send({ error: friendlyOpenAIError(err) });
    }
  } finally {
    res.end();
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`LeetCode Mentor listening on :${PORT}`);
});
