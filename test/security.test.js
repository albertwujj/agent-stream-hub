const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SECRET = 'test-only-hub-secret';
const AUTH = { 'X-Hub-Secret': SECRET };

async function startHub(t, env = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', STREAM_HUB_SECRET: SECRET, WHISPER_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit');
      proc.kill();
      await exited;
    }
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hub startup timed out')), 5000);
    proc.once('error', err => { clearTimeout(timer); reject(err); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`hub exited ${code}`)); });
    proc.stdout.on('data', data => {
      const match = data.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return async (method, route, body, headers = {}) => {
    const options = { method, headers: { ...headers } };
    if (body !== undefined) {
      options.body = Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!Buffer.isBuffer(body)) options.headers['Content-Type'] = 'application/json';
    }
    // Raw HTTP preserves Host and Fetch Metadata headers for the boundary
    // tests; fetch may replace these with its own values.
    return new Promise((resolve, reject) => {
      const request = http.request(base + route, options, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed, headers: new Headers(res.headers), base });
        });
        res.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(40000, () => request.destroy(new Error('test request timed out')));
      request.end(options.body);
    });
  };
}

test('viewer authentication cannot be bypassed by missing or forged proxy headers', async t => {
  const req = await startHub(t);
  assert.equal((await req('POST', '/runs', { runId: 'auth' })).status, 204);
  const routes = [
    ['GET', '/runs'], ['GET', '/runs/auth/latest'], ['GET', '/runs/auth/history'],
    ['DELETE', '/runs/auth'], ['POST', '/runs/auth/input', { prompt: 'do not deliver' }],
    ['POST', '/runs/auth/voice', Buffer.from('not audio')],
  ];
  for (const headers of [{}, { 'CF-Connecting-IP': '127.0.0.1' }, { 'X-Hub-Secret': 'wrong' }]) {
    for (const [method, route, body] of routes) {
      assert.equal((await req(method, route, body, headers)).status, 401, `${method} ${route}`);
    }
  }
  assert.equal((await req('GET', '/runs', undefined, AUTH)).status, 200);
  assert.deepEqual((await req('POST', '/runs/auth/heartbeat', {})).body.inputs, []);
  assert.equal((await req('POST', '/runs/auth/input', { prompt: 'allowed' }, AUTH)).status, 204);
  assert.deepEqual((await req('POST', '/runs/auth/heartbeat', {})).body.inputs, ['allowed']);
  assert.equal((await req('DELETE', '/runs/auth', undefined, AUTH)).status, 204);
});

test('other websites cannot read or write a local hub; normal links can open its viewer', async t => {
  const req = await startHub(t, { STREAM_HUB_SECRET: '' });
  const home = await req('GET', '/', undefined, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  for (const headers of [
    { Origin: 'https://other.example' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
    { Host: 'rebound.example' }, { 'CF-Connecting-IP': '192.0.2.1' },
  ]) {
    for (const [method, route, body] of [['GET', '/runs'], ['POST', '/runs', { runId: 'blocked' }], ['OPTIONS', '/runs']]) {
      const res = await req(method, route, body, headers);
      assert.equal(res.status, 403, `${method} ${route} ${JSON.stringify(headers)}`);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
  }
  assert.equal((await req('POST', '/runs', { runId: 'local' }, { Origin: home.base })).status, 204);
  assert.equal((await req('POST', '/runs', Buffer.from('{"runId":"form"}'), { 'Content-Type': 'text/plain' })).status, 415);
  const list = await req('GET', '/runs');
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.body.runs.map(r => r.runId), ['local']);
});

test('malformed and oversized metadata/snapshots cannot poison the viewer', async t => {
  const req = await startHub(t);
  for (const meta of [null, [], { runId: '../bad' }, { runId: 'bad', title: {} }]) {
    assert.equal((await req('POST', '/runs', meta)).status, 400);
  }
  assert.equal((await req('POST', '/runs', { runId: 'large', title: 'x'.repeat(16384) })).status, 413);
  assert.equal((await req('POST', '/runs', { runId: 'valid' })).status, 204);
  for (const payload of [null, { rows: 'not rows' }, { rows: [null] }, { rows: [{ text: {} }] }, { rows: [{ text: 'x', styles: [{ start: 0, end: 1, fg: {} }] }] }]) {
    assert.equal((await req('POST', '/runs/valid/snapshot', { seq: 1, payload })).status, 400);
  }
  assert.equal((await req('POST', '/runs/valid/heartbeat', null)).status, 400);
  assert.equal((await req('GET', '/runs/%ZZ/latest', undefined, AUTH)).status, 400);
  assert.equal((await req('GET', '/runs/valid/latest', undefined, AUTH)).body.snapshot, null);
});

test('input queues are bounded by count and bytes and recover after draining', async t => {
  const req = await startHub(t);
  await req('POST', '/runs', { runId: 'queue' });
  for (let i = 0; i < 64; i++) {
    assert.equal((await req('POST', '/runs/queue/input', { prompt: 'a', source: i % 2 ? 'voice' : 'typed' }, AUTH)).status, 204);
  }
  assert.equal((await req('POST', '/runs/queue/input', { prompt: 'overflow' }, AUTH)).status, 429);
  const drained = (await req('POST', '/runs/queue/heartbeat', {})).body;
  assert.equal(drained.inputs.length + drained.voiceInputs.length, 64);
  assert.equal((await req('POST', '/runs/queue/input', { prompt: '好'.repeat(22000) }, AUTH)).status, 429);
  assert.equal((await req('POST', '/runs/queue/input', { prompt: 'recovered' }, AUTH)).status, 204);
});

test('run capacity rejects new registrations without overwriting existing runs', async t => {
  const req = await startHub(t);
  for (let i = 0; i < 128; i++) assert.equal((await req('POST', '/runs', { runId: `run-${i}` })).status, 204);
  assert.equal((await req('POST', '/runs', { runId: 'overflow' })).status, 503);
  assert.equal((await req('POST', '/runs', { runId: 'run-0', title: 'updated' })).status, 204);
  await req('DELETE', '/runs/run-1', undefined, AUTH);
  assert.equal((await req('POST', '/runs', { runId: 'replacement' })).status, 204);
});

test('snapshot storage is bounded per run and globally, retaining recent data', async t => {
  const req = await startHub(t);
  for (let run = 0; run < 10; run++) {
    const id = `ring-${run}`;
    await req('POST', '/runs', { runId: id });
    for (let seq = 1; seq <= 10; seq++) {
      const payload = { runId: id, rows: [{ text: `${seq}:` + 'x'.repeat(1024 * 1024) }] };
      assert.equal((await req('POST', `/runs/${id}/snapshot`, { seq, payload })).status, 200);
    }
    const entries = (await req('GET', `/runs/${id}/history?limit=400`, undefined, AUTH)).body.entries;
    assert(entries.length < 8);
    assert.equal(entries.at(-1).seq, 10);
  }
  let bytes = 0;
  for (let run = 0; run < 10; run++) {
    const entries = (await req('GET', `/runs/ring-${run}/history?limit=400`, undefined, AUTH)).body.entries;
    bytes += entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
  }
  assert(bytes <= 64 * 1024 * 1024);
  const newest = (await req('GET', '/runs/ring-9/latest', undefined, AUTH)).body.snapshot;
  assert.equal(newest.seq, 10);
  // Deletion must release accounting as well as stored objects.
  for (let run = 0; run < 10; run++) await req('DELETE', `/runs/ring-${run}`, undefined, AUTH);
  await req('POST', '/runs', { runId: 'after-delete' });
  assert.equal((await req('POST', '/runs/after-delete/snapshot', { seq: 1, payload: { rows: [{ text: 'still healthy' }] } })).status, 200);
});

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }

test('voice accepts phone formats, rejects playlists/long audio, and limits concurrency', { skip: !ffmpeg }, async t => {
  let whisperCalls = 0;
  let hold = false;
  const held = [];
  const whisper = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      whisperCalls++;
      const reply = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: 'test transcript', segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0 }] }));
      };
      if (hold) held.push(reply); else reply();
    });
  });
  whisper.listen(0, '127.0.0.1');
  await once(whisper, 'listening');
  t.after(() => { held.splice(0).forEach(reply => reply()); whisper.closeAllConnections(); whisper.close(); });
  const req = await startHub(t, { WHISPER_URL: `http://127.0.0.1:${whisper.address().port}/inference` });
  await req('POST', '/runs', { runId: 'voice' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audio-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audio = (name, seconds, codec) => {
    const file = path.join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', codec, file]);
    return fs.readFileSync(file);
  };
  const mp4 = audio('recording.m4a', 0.2, 'aac');
  const webm = audio('recording.webm', 0.2, 'libopus');
  for (const buf of [mp4, webm]) {
    const res = await req('POST', '/runs/voice/voice', buf, AUTH);
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, true);
  }
  const before = whisperCalls;
  for (const playlist of [
    `ffconcat version 1.0\nfile '${path.join(dir, 'recording.m4a')}'\n`,
    `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${whisper.address().port}/not-audio\n#EXT-X-ENDLIST\n`,
  ]) assert.equal((await req('POST', '/runs/voice/voice', Buffer.from(playlist), AUTH)).status, 400);
  const long = audio('long.m4a', 122, 'aac');
  assert(long.length < 4 * 1024 * 1024);
  assert.equal((await req('POST', '/runs/voice/voice', long, AUTH)).status, 400);
  assert.equal(whisperCalls, before, 'rejected recordings must not reach transcription');
  hold = true;
  const pending = [req('POST', '/runs/voice/voice', mp4, AUTH), req('POST', '/runs/voice/voice', webm, AUTH)];
  const deadline = Date.now() + 5000;
  while (held.length < 2) {
    assert(Date.now() < deadline, 'two transcriptions should reach the stub');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await req('POST', '/runs/voice/voice', mp4, AUTH)).status, 429);
  hold = false;
  held.splice(0).forEach(reply => reply());
  assert.deepEqual((await Promise.all(pending)).map(r => r.status), [200, 200]);
  assert.equal((await req('POST', '/runs/voice/voice', mp4, AUTH)).status, 200);
});
