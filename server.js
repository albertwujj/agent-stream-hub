// agent-stream-hub — schema-agnostic relay.
//
// In-memory per-run entries. Sources register, push snapshots, heartbeat.
// Viewers list runs and fetch /latest (most-recent snapshot) and /history
// (older snapshots for backfill). No markers, no blocks — the viewer just
// stitches snapshots into a continuous buffer.
//
// Bind to 127.0.0.1 — public exposure is via cloudflared (separate process).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 9000;

const RING_CAP = 400;             // entries kept per run (snapshots + markers)
const EVICT_MS = 24 * 60 * 60 * 1000; // hard memory bound: runs are forgotten after a day with no activity
const MAX_BODY = 4 * 1024 * 1024; // 4 MiB per POST
// Compaction: two adjacent SNAPSHOT entries are considered "nearly
// identical" (newer overwrites older instead of being appended) when
// ≥COMPACT_TEXT_MATCH of their rows have identical text. Markers
// never compact — they're discrete events the viewer needs to see.
const COMPACT_TEXT_MATCH = 0.9;

// Voice input (voice.md). URL of a running whisper-server's /inference
// endpoint. If unset, POST /runs/:id/voice returns 503 — voice is an
// optional add-on; the hub runs fine without it.
const WHISPER_URL = process.env.WHISPER_URL || null;

// Confidence gate thresholds (voice.md) — whisper's stock values; calibrate
// from utterance logs once real usage accumulates.
const GATE_AVG_LOGPROB = -1.0; // below → low_confidence
const GATE_NO_SPEECH = 0.6;    // above (with weak logprob) → no_speech
const GATE_COMPRESSION = 2.4;  // above → low_confidence (repetition loop)

// Shared secret. If unset, the hub is fully open (dev/local mode).
// If set, any request that arrived via cloudflared (CF-Connecting-IP
// header present) must carry the matching X-Hub-Secret. Loopback
// requests originating on the hub host itself skip auth — keeps
// SSH-in debugging trivial.
const STREAM_HUB_SECRET = process.env.STREAM_HUB_SECRET || null;

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Per-run state. Every ring entry is a snapshot. voiceInputs are drained
 * alongside inputs on heartbeat but kept separate so the source can prefix
 * voice-origin text with the guide reference (voice.md). lastViewedAt is
 * bumped by the detail-view endpoints (/latest, /history) and relayed to
 * the source as an age so it can pace its heartbeat by viewer presence.
 * @type {Map<string, {
 *   meta: object,
 *   ring: Array<{seq:number, ts:number, payload:any}>,
 *   lastSeen: number,
 *   lastViewedAt: number,
 *   isWorking: boolean,
 *   inputs: string[],
 *   voiceInputs: string[],
 * }>}
 */
const runs = new Map();

// Age (not a timestamp): hub and source clocks can't be compared, but
// "how long ago" is clock-free — same reasoning as seq-vs-ts elsewhere.
function viewerAgeMs(r) {
  return r.lastViewedAt ? Date.now() - r.lastViewedAt : null;
}

// Returns true when two snapshot payloads are near-duplicates (same row
// count, ≥COMPACT_TEXT_MATCH rows with identical text). Used to compact
// spinner-frame churn in the ring.
function nearlyIdentical(prev, next) {
  if (!prev || !next) return false;
  if (prev.runId !== next.runId) return false;
  const pr = prev.rows || [];
  const nr = next.rows || [];
  if (pr.length !== nr.length) return false;
  if (pr.length === 0) return true;
  let identical = 0;
  for (let i = 0; i < pr.length; i++) {
    const pt = (pr[i] && pr[i].text) || '';
    const nt = (nr[i] && nr[i].text) || '';
    if (pt === nt) identical++;
  }
  return identical / pr.length >= COMPACT_TEXT_MATCH;
}

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return readBodyRaw(req).then((b) => b.toString('utf8'));
}

// Decode whatever container the phone's MediaRecorder produced (mp4/AAC on
// iOS Safari, webm/opus elsewhere) into the 16 kHz mono WAV whisper expects.
// Via a temp file, not a pipe: mp4 needs seekable input (moov atom can sit at
// the end). ffmpeg sniffs the container from the bytes; Content-Type is
// ignored.
async function decodeTo16kWav(audio) {
  const tmp = path.join(os.tmpdir(), `hub-voice-${crypto.randomBytes(8).toString('hex')}`);
  await fs.promises.writeFile(tmp, audio);
  try {
    return await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', tmp, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
      ]);
      const out = [];
      const err = [];
      ff.stdout.on('data', (c) => out.push(c));
      ff.stderr.on('data', (c) => err.push(c));
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0 && out.length) resolve(Buffer.concat(out));
        else reject(new Error(Buffer.concat(err).toString('utf8').trim() || `ffmpeg exited ${code}`));
      });
    });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// One round trip to whisper-server. temperature_inc=1.0 caps the fallback
// ladder at a single retry — garbled audio should fail fast into the phone's
// review path, not burn 3–8s re-decoding (voice.md).
async function transcribe(wav) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0.0');
  form.append('temperature_inc', '1.0');
  const res = await fetch(WHISPER_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper-server ${res.status}`);
  return res.json();
}

// Utterance-level gate signals: duration-weighted mean log-prob and worst-
// case no-speech from whisper's per-segment stats; compression ratio computed
// here from the transcript (whisper-server's verbose_json omits it, and it's
// just deflate anyway) — high ratio flags repetition-loop hallucinations.
function gateSignals(result, transcript) {
  const segs = result.segments || [];
  let dur = 0;
  let lpSum = 0;
  let noSpeech = 0;
  for (const s of segs) {
    const d = Math.max((s.end ?? 0) - (s.start ?? 0), 0.01);
    dur += d;
    lpSum += (s.avg_logprob ?? 0) * d;
    noSpeech = Math.max(noSpeech, s.no_speech_prob ?? 0);
  }
  const comp = transcript
    ? Buffer.byteLength(transcript, 'utf8') / zlib.deflateSync(Buffer.from(transcript, 'utf8')).length
    : 0;
  return {
    avgLogprob: segs.length ? lpSum / dur : -10,
    noSpeechProb: segs.length ? noSpeech : 1,
    compressionRatio: comp,
  };
}

// Peak 100ms-window RMS of the decoded 16-bit PCM. Zero-energy audio must
// never reach whisper: digital silence is out-of-distribution and decodes to
// confident hallucinated text ("Thank you.") with no_speech_prob ~0 — the
// model signal does NOT fire on it (verified). Server-side VAD would be the
// fuller fix, but whisper-server crashes when VAD filters out all speech.
const SILENCE_RMS = 150; // ~-47 dBFS peak window → treat as no speech
function peakRms(wav) {
  const data = wav.indexOf('data');
  if (data < 0 || data + 8 >= wav.length) return 0;
  const pcm = wav.subarray(data + 8);
  const win = (16000 / 10) * 2; // 100 ms of 16-bit mono samples
  let peak = 0;
  for (let off = 0; off < pcm.length; off += win) {
    const end = Math.min(off + win, pcm.length);
    let sum = 0;
    let n = 0;
    for (let i = off; i + 1 < end; i += 2) {
      const s = pcm.readInt16LE(i);
      sum += s * s;
      n++;
    }
    if (n) peak = Math.max(peak, Math.sqrt(sum / n));
  }
  return peak;
}

// null → confident, auto-send. Whisper hallucinates on silence, so no_speech
// needs its own verdict — a pocket-tap can carry a non-empty transcript.
function gateVerdict(transcript, sig) {
  if (!transcript || (sig.noSpeechProb > GATE_NO_SPEECH && sig.avgLogprob < GATE_AVG_LOGPROB)) return 'no_speech';
  if (sig.avgLogprob < GATE_AVG_LOGPROB || sig.compressionRatio > GATE_COMPRESSION) return 'low_confidence';
  return null;
}

function send(res, code, body, headers = {}) {
  if (typeof body === 'object' && body !== null) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(code, headers);
  res.end(body);
}

const ok = (res, obj) => send(res, 200, obj);
const noContent = (res) => { res.writeHead(204); res.end(); };
const badRequest = (res, msg) => send(res, 400, (msg || 'bad request') + '\n');
const notFound = (res) => send(res, 404, 'not found\n');

// Serve a static file from public/. Returns true if a file was served.
function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (urlPath.includes('..')) return false;
  const relPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, relPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) return false;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const ctype = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// Fail-closed auth: every tunneled /runs* request needs the secret unless
// explicitly whitelisted.
function requiresAuth(req, path) {
  if (!req.headers['cf-connecting-ip']) return false;
  if (!path.startsWith('/runs')) return false;
  if (isOpenSourcePost(req, path)) return false;
  return true;
}

// Source-side streaming POSTs that don't require the secret. Sources
// (Windows agent-term) can register + push without secrets so corporate
// machines don't need shared-secret distribution.
function isOpenSourcePost(req, path) {
  if (req.method !== 'POST') return false;
  if (path === '/runs') return true;
  if (/^\/runs\/[^/]+\/(snapshot|heartbeat)$/.test(path)) return true;
  return false;
}

async function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hub-Secret');
  if (req.method === 'OPTIONS') return noContent(res);

  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const path = url.pathname;

  if (STREAM_HUB_SECRET && requiresAuth(req, path)) {
    if (req.headers['x-hub-secret'] !== STREAM_HUB_SECRET) {
      return send(res, 401, 'unauthorized\n');
    }
  }

  // POST /runs  — register or update meta
  if (req.method === 'POST' && path === '/runs') {
    let meta;
    try { meta = JSON.parse(await readBody(req)); } catch { return badRequest(res, 'invalid json'); }
    if (!meta || typeof meta.runId !== 'string') return badRequest(res, 'missing runId');
    const now = Date.now();
    const existing = runs.get(meta.runId);
    if (existing) {
      existing.meta = meta;
      existing.lastSeen = now;
    } else {
      runs.set(meta.runId, { meta, ring: [], lastSeen: now, lastViewedAt: 0, isWorking: false, inputs: [], voiceInputs: [] });
    }
    return noContent(res);
  }

  // GET /runs — list every known run. Viewer renders freshness from lastSeenAt.
  if (req.method === 'GET' && path === '/runs') {
    const list = [];
    for (const r of runs.values()) {
      list.push({ ...r.meta, lastSeenAt: r.lastSeen, isWorking: !!r.isWorking });
    }
    return ok(res, { runs: list });
  }

  // /runs/:id/...
  const m = path.match(/^\/runs\/([^\/]+)(?:\/(.+))?$/);
  if (m) {
    const runId = decodeURIComponent(m[1]);
    const rest = m[2];

    // DELETE /runs/:id
    if (req.method === 'DELETE' && !rest) {
      runs.delete(runId);
      return noContent(res);
    }

    // POST /runs/:id/heartbeat — carries the source's current isWorking flag.
    // Response drains any queued viewer inputs.
    if (req.method === 'POST' && rest === 'heartbeat') {
      const r = runs.get(runId);
      if (!r) return notFound(res);
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      if (typeof body.isWorking === 'boolean') r.isWorking = body.isWorking;
      r.lastSeen = Date.now();
      const inputs = r.inputs;
      r.inputs = [];
      const voiceInputs = r.voiceInputs;
      r.voiceInputs = [];
      return ok(res, { inputs, voiceInputs, viewerAgeMs: viewerAgeMs(r) });
    }

    // POST /runs/:id/input — viewer-submitted prompt; drained on next heartbeat.
    // source:"voice" marks a reviewed/edited transcript — still a transcript,
    // so the source gives it the guide framing (voice.md).
    if (req.method === 'POST' && rest === 'input') {
      const r = runs.get(runId);
      if (!r) return notFound(res);
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return badRequest(res, 'invalid json'); }
      if (!body || typeof body.prompt !== 'string' || !body.prompt) return badRequest(res, 'missing prompt');
      if (body.source === 'voice') r.voiceInputs.push(body.prompt);
      else r.inputs.push(body.prompt);
      return noContent(res);
    }

    // POST /runs/:id/voice — raw audio in (any MediaRecorder container),
    // transcript + gate verdict out; auto-queues on confidence. Contract:
    // voice.md. Synchronous: transcribe + gate + queue in one round trip.
    if (req.method === 'POST' && rest === 'voice') {
      const r = runs.get(runId);
      if (!r) return notFound(res);
      if (!WHISPER_URL) return send(res, 503, 'voice not configured\n');
      let audio;
      try { audio = await readBodyRaw(req); } catch { return badRequest(res, 'payload too large'); }
      if (audio.length === 0) return badRequest(res, 'empty body');
      let wav;
      try { wav = await decodeTo16kWav(audio); } catch { return badRequest(res, 'undecodable audio'); }
      if (peakRms(wav) < SILENCE_RMS) {
        return ok(res, { transcript: '', sent: false, holdReason: 'no_speech', signals: null });
      }
      let result;
      try { result = await transcribe(wav); } catch (e) {
        console.error('[voice]', e.message);
        return send(res, 503, 'whisper unavailable\n');
      }
      // Whisper joins segments with newlines; collapse to one line — a
      // newline in typed input would submit the command early at the PTY.
      const transcript = (result.text || '').replace(/\s+/g, ' ').trim();
      const signals = gateSignals(result, transcript);
      const holdReason = gateVerdict(transcript, signals);
      if (!holdReason) r.voiceInputs.push(transcript);
      return ok(res, { transcript, sent: !holdReason, holdReason, signals });
    }

    // POST /runs/:id/snapshot — a viewport row array. Compacted when
    // adjacent to a near-identical previous snapshot.
    if (req.method === 'POST' && rest === 'snapshot') {
      const r = runs.get(runId);
      if (!r) return notFound(res);
      let msg;
      try { msg = JSON.parse(await readBody(req)); } catch { return badRequest(res, 'invalid json'); }
      if (!msg || typeof msg.seq !== 'number') return badRequest(res, 'missing seq');
      const stored = { seq: msg.seq, ts: Date.now(), payload: msg.payload };
      const last = r.ring.length > 0 ? r.ring[r.ring.length - 1] : null;
      if (last && nearlyIdentical(last.payload, stored.payload)) {
        r.ring[r.ring.length - 1] = stored;
      } else {
        r.ring.push(stored);
        if (r.ring.length > RING_CAP) r.ring.shift();
      }
      r.lastSeen = stored.ts;
      if (msg.payload && typeof msg.payload.isWorking === 'boolean') {
        r.isWorking = msg.payload.isWorking;
      }
      // Snapshot acks carry viewer presence so a WORKING source (30s
      // heartbeats, but frequent snapshots via spinner churn) learns
      // "someone just opened the view" within a second or two instead
      // of a heartbeat period. Old sources ignore the body.
      return ok(res, { viewerAgeMs: viewerAgeMs(r) });
    }

    // GET /runs/:id/latest — viewer's hot-path poll. Returns the most
    // recent snapshot plus a count of viewer-submitted inputs still
    // waiting to be drained by the source on its next heartbeat.
    if (req.method === 'GET' && rest === 'latest') {
      const r = runs.get(runId);
      if (!r) return notFound(res);
      // Detail-view poll = viewer engagement; refreshed every ~1.5s while
      // the view is open. Relayed to the source (heartbeat/snapshot acks)
      // to promote its heartbeat pace while someone is watching.
      r.lastViewedAt = Date.now();
      const snap = r.ring.length > 0 ? r.ring[r.ring.length - 1] : null;
      return ok(res, {
        snapshot: snap,
        lastSeenAt: r.lastSeen,
        isWorking: !!r.isWorking,
        pendingInputs: r.inputs.length + r.voiceInputs.length,
      });
    }

    // GET /runs/:id/history?before=<seq>&limit=N — older snapshots
    // for "load earlier" pagination, oldest→newest.
    if (req.method === 'GET' && rest === 'history') {
      const r = runs.get(runId);
      if (!r) return notFound(res);
      r.lastViewedAt = Date.now();
      const beforeRaw = url.searchParams.get('before');
      const limitRaw = url.searchParams.get('limit');
      const before = beforeRaw == null ? Infinity : Number(beforeRaw);
      const limit = limitRaw == null ? 50 : Math.min(Math.max(1, Number(limitRaw)), RING_CAP);
      const out = [];
      for (let i = r.ring.length - 1; i >= 0 && out.length < limit; i--) {
        if (r.ring[i].seq < before) out.unshift(r.ring[i]);
      }
      return ok(res, { entries: out });
    }
  }

  // Static viewer SPA.
  if (serveStatic(req, res, path)) return;

  return notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[err]', err.message);
    if (!res.headersSent) send(res, 500, 'internal\n');
  });
});

setInterval(() => {
  const cutoff = Date.now() - EVICT_MS;
  for (const [id, r] of runs) {
    if (r.lastSeen < cutoff) runs.delete(id);
  }
}, 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`[hub] listening on http://${HOST}:${PORT}`);
});
