# Voice input — product design

Speak a command to a streamed AI-CLI session from the phone viewer; the hub
transcribes it and the source types it into the PTY. Status: **live in production**
(hub route + whisper daemon deployed, source drain shipped); on-device phone-mic
testing pending. Phone-side UX: [VOICE_UX.md](./VOICE_UX.md). The agent-facing
instructions (`interpretation-guide.md`) and their rationale live in the
[voice-to-agent](https://github.com/albertwujj/voice-to-agent) kit — vendored into
consuming projects, referenced by the injected prompt below.

## Flow

```
phone: toggle record (opus/aac)
   │  POST /runs/:id/voice
   ▼
hub: whisper.cpp large-v3-turbo (warm)  →  transcript + confidence
   │
   ├─ gate holds? ──yes──►  return sent:false → phone review/edit
   │        │ no
   ▼
   queue voice-tagged  →  source drains on heartbeat  →  agent CLI receives:
   User input transcript — find voice-to-agent/interpretation-guide.md and follow it:
   <raw transcript>
```

Nothing in the pipeline corrects the transcript. The agent CLI — richer context than
any viewport snapshot (files, whole conversation, tools) — reconstructs intent per
the guide. A hub-side corrector (earlier design: qwen via Ollama) was dropped as
strictly worse; so was whisper `--prompt` session-vocab biasing (see below).

## Transcription (hub, whisper.cpp)

**Model:** `large-v3-turbo` (1.6 GB) — accent-robust (weakly-supervised web-scale
training), Metal-accelerated, ~10x real-time. **Decode: beam-5** (whisper-cli
default) — measured +0.02–0.08 s over greedy on the M4, and it lets later audio
overturn an early wrong pick instead of cascading (autoregressive conditioning makes
errors self-reinforcing under greedy).

**Caching = residency.** Whisper has no cross-request cache; every utterance is
independent. Keep one resident `whisper-server` (launchd, like hub + cloudflared):
weights stay in RAM (cold load ~7–9 s), one warmup inference at boot compiles the
Metal pipeline. Idle cost ≈ zero.

**Latency (measured, M4):** warm inference ~1.5–2 s, nearly flat in utterance length
(the encoder always processes a fixed 30 s window; only the token loop grows —
4 s clip 1.75 s, 20 s clip 1.9 s). Upload + ffmpeg resample add <0.4 s. Streaming
transcription rejected: no long-clip penalty to fix.

**Config:** temperature-fallback capped at 1 retry (stock ladder can re-decode ~5x —
hidden 3–8 s variance; garbled audio goes to the hold path instead), language pinned
`en` (skips detection; stops accented speech being misrouted mid-utterance),
`condition_on_previous_text=false` and no cross-utterance chaining (one mis-hear must
not seed the next command).

**Launch (the flags matter):**

```
whisper-server -m ggml-large-v3-turbo.bin --host 127.0.0.1 --port 8091 -l en -bs 5
```

`-bs 5` is required — whisper-server's default is **greedy** (`-1`), unlike
whisper-cli's beam-5, so omitting it silently loses the beam decision. Do **not**
enable server-side VAD: verified crash when VAD filters out all speech (language
detection runs on 0 ms of audio and the process dies) — a daemon that dies on every
pocket-tap. Silence is handled hub-side instead (below); revisit VAD when fixed
upstream.

**Silence energy gate (hub-side, before whisper).** Verified: pure digital silence
decodes to confident hallucinated text — "Thank you." with `no_speech_prob` ~1e-13;
the model signal does *not* fire on zero-energy audio (it's out-of-distribution —
real silence has mic noise). The hub computes peak 100 ms-window RMS on the decoded
PCM and holds anything below ~-47 dBFS as `no_speech` without calling whisper
(`signals: null` in the response). Real pocket audio with rustle still reaches
whisper, where `no_speech_prob` operates in-distribution.

**No `--prompt` session-vocab biasing.** Unbiased whisper errs *phonetically
faithfully* ("pie test") — visibly weird, which is what triggers the agent's repair,
and the sound-shadow survives in the text. Biased whisper snaps sounds to session
terms, and a wrong snap is context-plausible by construction — invisible to the
agent's context check — while prompt support also inflates token confidence,
corrupting the gate. Bias's legitimate wins (casing, spelling) are what the agent
fixes anyway. Personalization belongs in the weights: log (audio, corrected-text)
pairs and LoRA-fine-tune per speaker later.

## Confidence gate

Signals: **avg token log-prob** (duration-weighted across segments; primary),
**`no_speech_prob`** (worst segment), **compression ratio** — computed hub-side from
the transcript via deflate, because whisper-server's verbose_json omits it (catches
repetition-loop hallucinations). Auto-send unless clearly bad — the bar for holding
is high. Calibrate thresholds on the speaker's real utterances (accent shifts the
distribution); the utterance log doubles as the future fine-tune corpus.

The transcript is whitespace-collapsed to one line before queueing: whisper joins
segments with newlines, and a newline in typed input submits the command early at
the PTY.

## `/voice` API

`POST /runs/:runId/voice` — synchronous (~2 s), one round trip. Auth falls out of
existing middleware (`/runs/*` viewer routes need `X-Hub-Secret` when tunneled).

**Input:** raw audio bytes as the body (no multipart). Any `MediaRecorder` container
(mp4/AAC on iOS Safari — the primary client; webm/opus elsewhere); ffmpeg sniffs, so
`Content-Type` is advisory. 4 MiB cap ≈ 2–3 min; cap recording client-side.

**Output (200):**

```jsonc
{
  "transcript": "...",          // raw whisper text, untouched     [required]
  "sent": true,                 // auto-queued for the source?     [required]
  "holdReason": null,           // why sent is false: "low_confidence" | "no_speech";
                                // always null when sent is true   [required]
  "signals": {                  // gate inputs, passed through     [optional]
    "avgLogprob": -0.21, "noSpeechProb": 0.02, "compressionRatio": 1.4
  }                             // null when whisper was skipped (energy gate)
}
```

`holdReason` is not derivable client-side: whisper hallucinates on silence, so a
pocket-tap can yield a non-empty transcript — without the verdict the phone would
open the editor with garbage instead of "didn't catch that". Errors: plain text,
`404` unknown run, `400` undecodable audio, `503` whisper-server down.

**Side effect on `sent:true`:** the bare transcript (no guide prefix — injection is
the source's job, which owns per-`cli` behavior) is queued voice-tagged. The
heartbeat drain gains a parallel field; the typed path is untouched:

```jsonc
{ "inputs": ["typed text"], "voiceInputs": ["restart the pty and rerun pie test"] }
```

Old sources ignore the field. `/input` also accepts `source: "voice"` (routes to the
voice queue → guide framing); the PWA currently sends reviewed held transcripts as
plain typed input instead — a user-reviewed transcript ≈ typed text — so the tag is
there for clients that want it, unused by the viewer.

No "literal shell" guard: runs only register when `prompt-capture` sees a first
prompt to an AI CLI, so a raw shell never has a run to voice into.

## Injection (source, agent-term)

Per voice-origin input the source injects a header line, then the transcript on
its own line (agent-term's convention for injected prompts; delivered via
bracketed paste so the newline doesn't submit early):

```
User input transcript — find voice-to-agent/interpretation-guide.md and follow it:
<raw transcript>
```

- **Folder-qualified name, no path.** The source holds one constant; the kit repo is
  vendored with its folder name kept, anywhere in the tree. The folder is the
  namespace (a bare filename could collide with a project's own docs).
- **Every time, no state.** No primed flag, no compaction detection — the agent
  globs, remembers, and re-reads only if the guide was compacted out of its context.
- **Graceful when absent.** The "User input transcript —" label alone tells the agent
  it's the user's dictated request (parallel to the `[… from terminal host]` prefix on
  the host's own injections into this stream); the guide sharpens, it is not a hard
  dependency.

Prompt/filename co-design rationale: `voice-to-agent/.maintainer/`.

## Delivery latency

Warm whisper is ~2 s; the queued transcript then waits for the source's heartbeat.
The heartbeat is adaptive, and **viewer presence promotes it**: opening a run's
detail view (the viewer's ~1.5 s `/latest` polling) is relayed to the source as
`viewerAgeMs` on heartbeat *and snapshot* acks, so a working source learns someone
is watching within a second or two (snapshots flow constantly mid-work) and holds
top pace (2 s) even while `isWorking`. Decay is the 5-min window expiring after the
last detail-view poll. Net: **~3–5 s spoken → typed, regardless of whether the
agent is idle or mid-task**, as long as you're looking at the session — which
dictation implies. Remaining edge: agent working with a totally silent viewport and
no viewer yet promoted → up to one 30 s heartbeat; rare (CLIs animate while
working). Plus the 200 ms fast-poll burst after any input drains, for follow-ups.

## Open items

- ~~`/voice` route in `server.js`~~ — shipped, with tests (stub whisper-server) and
  E2E-verified against a real whisper-server: confident/held/silence/garbage paths.
- ~~`voiceInputs` drain + guide-prefix injection in agent-term~~ — shipped; verified
  with a real StreamClient against a real hub (electron stubbed). PTY typing reuses
  the proven typed-input path.
- ~~Adaptive heartbeat~~ — already existed in agent-term (2 s idle / 30 s working +
  fast-poll after inputs); no work was needed. See Delivery latency above.
- ~~Record button + states in the viewer PWA~~ — shipped per
  [VOICE_UX.md](./VOICE_UX.md): in-field mic, level-ring recording state,
  silence hint, cap countdown, cancel, transcript panel (`sent` until the hub
  queue drains, min-dwell, `not delivered · agent offline` on stale), held →
  ordinary draft. **On-device testing (iOS Safari mic) still pending** — logic is
  static-verified only; real-mic behavior needs a phone.
- ~~`whisper-server` supervised on the mini~~ — deployed: `~/whisper-server/` +
  `/Library/LaunchDaemons/com.user.whisper-server.plist`, warmup on boot; hub
  reaches it via `WHISPER_URL` in its launcher. Deployment gotcha for other hosts:
  launchd daemons get a bare PATH — the hub's launcher must put Homebrew on it or
  ffmpeg spawn fails and every /voice decode 400s. E2E-verified in production
  (speech ~2 s auto-send; silence held). Remaining: on-device phone test.
- Utterance logging: confidence per utterance (gate calibration from data) + retained
  audio+transcript (fine-tune corpus).
