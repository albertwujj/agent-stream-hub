// Hub endpoint tests.
//
// Covers: register, snapshot push (with compaction), /latest shape,
// /history pagination, DELETE, heartbeat isWorking flow, and the /voice
// route against a stub whisper-server (VOICE.md).
//
// Spawns server.js on an ephemeral PORT so the production hub (if any)
// isn't disturbed.

const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const HUB_PORT = 9101;
const HUB_HOST = '127.0.0.1';
const BASE = `http://${HUB_HOST}:${HUB_PORT}`;
const STUB_WHISPER_PORT = 9102;

let hubProc = null;

function startHub(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(HUB_PORT), ...extraEnv };
    hubProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) { hubProc.kill(); reject(new Error('hub did not start in time')); }
    }, 5000);
    hubProc.stdout.on('data', (d) => {
      if (d.toString().includes('[hub] listening')) {
        ready = true;
        clearTimeout(timeout);
        setTimeout(resolve, 50);
      }
    });
    hubProc.stderr.on('data', (d) => process.stderr.write(`[hub] ${d}`));
    hubProc.on('exit', (code) => {
      if (!ready) { clearTimeout(timeout); reject(new Error(`hub exited with ${code}`)); }
    });
  });
}

function stopHub() { if (hubProc) hubProc.kill(); }

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + urlPath, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestRaw(method, urlPath, buf) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + urlPath, { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// --- Voice scaffolding (VOICE.md) ---

// Stub whisper-server: each test queues the verbose_json it wants back,
// steering the gate without real audio models.
const stubWhisper = { server: null, next: null };
function startStubWhisper() {
  return new Promise((resolve) => {
    stubWhisper.server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stubWhisper.next));
      });
    });
    stubWhisper.server.listen(STUB_WHISPER_PORT, HUB_HOST, resolve);
  });
}
function stopStubWhisper() { if (stubWhisper.server) stubWhisper.server.close(); }

// Minimal valid WAV (16 kHz mono PCM, 0.1 s) — enough for the hub's ffmpeg
// decode step to succeed; the stub decides the transcript. A 440 Hz tone by
// default: all-zero PCM would be held by the hub's silence energy gate
// before the stub is ever consulted.
function makeWav({ silent = false } = {}) {
  const samples = 1600;
  const data = Buffer.alloc(samples * 2);
  if (!silent) {
    for (let i = 0; i < samples; i++) {
      data.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function hasFfmpeg() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// Canned whisper verbose_json shapes. Real whisper-server segments carry
// avg_logprob and no_speech_prob but NOT compression_ratio (the hub computes
// that from the transcript), and multi-segment text joins with newlines.
const WHISPER_CONFIDENT = {
  text: ' restart the pty and rerun pytest\n on the module\n',
  segments: [{ start: 0, end: 3, text: ' restart the pty and rerun pytest', avg_logprob: -0.2, no_speech_prob: 0.02 }],
};
const WHISPER_GARBLED = {
  text: ' something mumbled',
  segments: [{ start: 0, end: 2, text: ' something mumbled', avg_logprob: -1.6, no_speech_prob: 0.1 }],
};
const WHISPER_SILENCE = {
  // Whisper hallucinates on silence — the transcript is non-empty on purpose.
  text: ' Thank you.',
  segments: [{ start: 0, end: 1, text: ' Thank you.', avg_logprob: -1.2, no_speech_prob: 0.92 }],
};
const WHISPER_LOOPY = {
  // Repetition-loop hallucination: confident stats, degenerate text.
  text: ' run the tests' + ' run the tests'.repeat(30),
  segments: [{ start: 0, end: 5, text: ' run the tests', avg_logprob: -0.3, no_speech_prob: 0.05 }],
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); failed++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'eq'}\n  got:  ${a}\n  want: ${e}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function main() {
  await startStubWhisper();
  try { await startHub({ WHISPER_URL: `http://${HUB_HOST}:${STUB_WHISPER_PORT}/inference` }); }
  catch (e) {
    console.error(`SKIP: could not start hub on ${HUB_PORT}: ${e.message}`);
    stopStubWhisper();
    process.exit(0);
  }

  try {
    const runId = 'test-basic';

    await test('POST /runs registers', async () => {
      const r = await request('POST', '/runs', { runId, cli: 'claude', host: 'h1', title: 'first prompt' });
      eq(r.status, 204);
    });

    await test('POST /runs/:id/snapshot stores; /latest returns it', async () => {
      const r = await request('POST', `/runs/${runId}/snapshot`, {
        seq: 1,
        payload: { runId, cols: 80, rows: [{ text: 'hello' }, { text: 'world' }], isWorking: false },
      });
      eq(r.status, 200);
      eq(r.body.viewerAgeMs, null, 'no viewer yet → null age');
      const l = await request('GET', `/runs/${runId}/latest`);
      eq(l.status, 200);
      eq(l.body.snapshot.payload.rows.map(r => r.text), ['hello', 'world']);
    });

    await test('viewer presence: /latest bump relayed as viewerAgeMs on snapshot + heartbeat acks', async () => {
      const vpId = 'test-viewer-presence';
      await request('POST', '/runs', { runId: vpId });
      const hb0 = await request('POST', `/runs/${vpId}/heartbeat`, {});
      eq(hb0.body.viewerAgeMs, null, 'never viewed → null');
      await request('GET', `/runs/${vpId}/latest`);   // viewer drills in
      const s = await request('POST', `/runs/${vpId}/snapshot`, {
        seq: 1, payload: { runId: vpId, rows: [{ text: 'x' }] },
      });
      assert(typeof s.body.viewerAgeMs === 'number' && s.body.viewerAgeMs < 2000,
        'snapshot ack carries fresh viewer age, got ' + s.body.viewerAgeMs);
      const hb = await request('POST', `/runs/${vpId}/heartbeat`, {});
      assert(typeof hb.body.viewerAgeMs === 'number' && hb.body.viewerAgeMs < 2000,
        'heartbeat carries fresh viewer age');
    });

    await test('compaction: near-identical snapshots overwrite the last entry', async () => {
      const compactId = 'test-compact';
      await request('POST', '/runs', { runId: compactId });
      for (let i = 0; i < 300; i++) {
        await request('POST', `/runs/${compactId}/snapshot`, {
          seq: i + 1,
          payload: { runId: compactId, rows: [{ text: 'static a' }, { text: 'static b' }] },
        });
      }
      // After 300 identical pushes the ring should hold a single compacted entry.
      const h = await request('GET', `/runs/${compactId}/history?limit=400`);
      eq(h.body.entries.length, 1);
    });

    await test('compaction: row text change beyond threshold appends', async () => {
      const churnId = 'test-churn';
      await request('POST', '/runs', { runId: churnId });
      for (let i = 0; i < 5; i++) {
        await request('POST', `/runs/${churnId}/snapshot`, {
          seq: i + 1,
          payload: { runId: churnId, rows: [{ text: 'v' + i + ' a' }, { text: 'v' + i + ' b' }] },
        });
      }
      const h = await request('GET', `/runs/${churnId}/history?limit=400`);
      eq(h.body.entries.length, 5);
    });

    await test('GET /history?before=<seq>&limit=N paginates', async () => {
      const pageId = 'test-page';
      await request('POST', '/runs', { runId: pageId });
      for (let i = 0; i < 10; i++) {
        await request('POST', `/runs/${pageId}/snapshot`, {
          seq: i + 1, payload: { runId: pageId, rows: [{ text: 'row ' + i }] },
        });
      }
      const r1 = await request('GET', `/runs/${pageId}/history?limit=3`);
      eq(r1.body.entries.map(e => e.seq), [8, 9, 10]);
      const r2 = await request('GET', `/runs/${pageId}/history?before=8&limit=3`);
      eq(r2.body.entries.map(e => e.seq), [5, 6, 7]);
    });

    await test('DELETE /runs/:id removes the run', async () => {
      await request('POST', '/runs', { runId: 'gone' });
      const d = await request('DELETE', '/runs/gone');
      eq(d.status, 204);
      const l = await request('GET', '/runs/gone/latest');
      eq(l.status, 404);
    });

    await test('isWorking flag flows through snapshot + heartbeat into /latest', async () => {
      const wId = 'test-working';
      await request('POST', '/runs', { runId: wId });
      await request('POST', `/runs/${wId}/snapshot`, {
        seq: 1, payload: { runId: wId, rows: [], isWorking: true },
      });
      const l1 = await request('GET', `/runs/${wId}/latest`);
      eq(l1.body.isWorking, true);
      await request('POST', `/runs/${wId}/heartbeat`, { isWorking: false });
      const l2 = await request('GET', `/runs/${wId}/latest`);
      eq(l2.body.isWorking, false);
    });

    await test('POST /input with source:voice routes to voiceInputs on drain', async () => {
      const vId = 'test-input-voice';
      await request('POST', '/runs', { runId: vId });
      await request('POST', `/runs/${vId}/input`, { prompt: 'typed text' });
      await request('POST', `/runs/${vId}/input`, { prompt: 'edited transcript', source: 'voice' });
      const l = await request('GET', `/runs/${vId}/latest`);
      eq(l.body.pendingInputs, 2, 'pendingInputs counts both queues');
      const hb = await request('POST', `/runs/${vId}/heartbeat`, {});
      eq(hb.body.inputs, ['typed text']);
      eq(hb.body.voiceInputs, ['edited transcript']);
      const hb2 = await request('POST', `/runs/${vId}/heartbeat`, {});
      eq(hb2.body.inputs, []);
      eq(hb2.body.voiceInputs, [], 'drain clears the voice queue');
    });

    if (hasFfmpeg()) {
      const vId = 'test-voice';
      await request('POST', '/runs', { runId: vId });

      await test('/voice: confident transcript auto-queues, newlines collapsed', async () => {
        stubWhisper.next = WHISPER_CONFIDENT;
        const r = await requestRaw('POST', `/runs/${vId}/voice`, makeWav());
        eq(r.status, 200);
        // Segment-join newlines collapse to spaces — a newline in typed input
        // would submit early at the PTY.
        eq(r.body.transcript, 'restart the pty and rerun pytest on the module');
        eq(r.body.sent, true);
        eq(r.body.holdReason, null);
        assert(typeof r.body.signals.avgLogprob === 'number', 'signals passed through');
        const hb = await request('POST', `/runs/${vId}/heartbeat`, {});
        eq(hb.body.voiceInputs, ['restart the pty and rerun pytest on the module']);
      });

      await test('/voice: repetition loop is held via hub-computed compression ratio', async () => {
        stubWhisper.next = WHISPER_LOOPY;
        const r = await requestRaw('POST', `/runs/${vId}/voice`, makeWav());
        eq(r.body.sent, false);
        eq(r.body.holdReason, 'low_confidence');
        assert(r.body.signals.compressionRatio > 2.4, 'loop detected');
      });

      await test('/voice: low confidence is held, not queued', async () => {
        stubWhisper.next = WHISPER_GARBLED;
        const r = await requestRaw('POST', `/runs/${vId}/voice`, makeWav());
        eq(r.body.sent, false);
        eq(r.body.holdReason, 'low_confidence');
        const hb = await request('POST', `/runs/${vId}/heartbeat`, {});
        eq(hb.body.voiceInputs, [], 'held transcript never reaches the queue');
      });

      await test('/voice: silence is no_speech despite hallucinated transcript', async () => {
        stubWhisper.next = WHISPER_SILENCE;
        const r = await requestRaw('POST', `/runs/${vId}/voice`, makeWav());
        eq(r.body.sent, false);
        eq(r.body.holdReason, 'no_speech');
        eq(r.body.transcript, 'Thank you.', 'transcript returned even when held');
      });

      await test('/voice: zero-energy audio held by the gate, whisper never consulted', async () => {
        stubWhisper.next = WHISPER_CONFIDENT; // must not matter
        const r = await requestRaw('POST', `/runs/${vId}/voice`, makeWav({ silent: true }));
        eq(r.body.sent, false);
        eq(r.body.holdReason, 'no_speech');
        eq(r.body.transcript, '');
        eq(r.body.signals, null, 'no whisper signals — inference skipped');
      });

      await test('/voice: undecodable audio is a 400', async () => {
        const r = await requestRaw('POST', `/runs/${vId}/voice`, Buffer.from('not audio at all'));
        eq(r.status, 400);
      });

      await test('/voice: unknown run is a 404', async () => {
        const r = await requestRaw('POST', '/runs/nope/voice', makeWav());
        eq(r.status, 404);
      });
    } else {
      console.log('~ /voice tests skipped: ffmpeg not installed');
    }
  } finally {
    stopHub();
    stopStubWhisper();
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); stopHub(); process.exit(1); });
