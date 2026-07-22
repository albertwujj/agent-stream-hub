# Voice input — phone UX

Voice is the **primary input method**. On phones the mic is the **biggest key**:
it owns a **full-width commit row** of its own, below a compact nav row
(`↑ ↓ esc ⇧tab ^C`) and above nothing — thumb-home at the bottom edge, labelled
`🎙 Speak`. The `↵` confirm joins it on that commit row once picker navigation
begins (empty while just replying — the keyboard's own return sends). On desktop
(no key rows) the mic is a keycap-class button next to the field. Always visible
while idle; **dimmed-disabled** when a draft (typed or held transcript) owns the
field, keeping the no-recording-over-a-draft rule visible instead of vanishing. The text field stays *above* the key row: the
bottom edge belongs to the most-frequent controls, and while actually typing
the key row hides anyway (`kbd-active`) so the field docks to the keyboard. No gesture conflict: long-press on the text field keeps its
native iOS meaning (cursor placement, paste), which the held-transcript editing
flow depends on. Everything else reuses what's there (input
bar, send path, status pill, live stream). Scope matches the required `/voice` API
surface only — no waveform, no live partial transcript, no settings, no signals
display.

## States

```
idle ──tap──► recording ──────tap (= send)──► transcribing ──► resolved
 🎙            [● 0:07 · tap to send    ] ✕     panel: "transcribing…"
```

The recording state is one calm surface: the whole row is the tap-to-send
button, all text at the input field's type scale, red exactly once (the dot),
the live level ring glowing on the row border. Cancel is a separate keycap so
it can't be fat-fingered into send. (One action → one visual scale; size
contrast implies hierarchy, and there is none here.)

## Recording feedback — prove capture, don't assert it

The worst dictation failure is speaking into a dead mic and learning at the end.
Feedback while speaking is therefore driven by the live audio samples, which can't
lie — not by UI state, which can:

- **Level ring**: the button morphs to a stop control wrapped in a ring pulsing with
  real mic amplitude (one `AnalyserNode` on the recording stream, ~10 fps). Not
  moving while speaking = visibly wrong, before the utterance is wasted.
- **"Can't hear you" hint** if the level stays ~silent for the first ~3 s — the
  silence gate's UX twin, moved to the start instead of after a full dictation.
- **Timer, cap-aware**: counts up; amber countdown in the last ~20 s of the ~2 min
  cap. At the cap: auto-stop and transcribe normally — never discard intentional
  speech.
- **Label the stop control `tap to send`** — under auto-send, stopping is sending;
  don't imply a review step that usually doesn't exist.
- **✕ cancel** beside the timer, discards the take. Required by auto-send: stop =
  send, so a flubbed take needs an exit. (Mid-sentence flubs don't need it — the
  guide's restatement rule means "…no, the linter" self-corrects.)
- **Interruption = discard, never send**: on `visibilitychange`/stream end (call,
  app switch — iOS suspends the recorder anyway), cancel with a notice. An
  interrupted take is a half-command; the gate can't know that. If losing long
  takes bites, a future `?hold=1` on `/voice` (transcribe-but-never-send) is the
  fix — not built.

No live partial transcript (transcription is full-clip on stop, by design), no
waveform history, no audio chimes.

**Resolved, by response:**

| Response | Phone behavior |
|---|---|
| `sent: true` | Transcript **panel** above the input bar: the full wrapped transcript at reading size (cap ~5 lines, then internal scroll), shown the instant the response lands — it's your only look at what was heard (no live partial). A small `sent` status rides beneath it: `sent` = the hub has it (`sent: true`), the same word the field pill uses for a typed send. The panel holds until the hub queue drains (`pendingInputs → 0` — the source pulled it, the reliable ack; the injected line is then in the terminal stream itself), but **never less than a min dwell** (~2.5 s) so the transcript stays readable even when delivery is instant, then fades. Covers the heartbeat gap (up to ~30 s if the agent was mid-task). If the run goes stale before the queue drains → `not delivered · agent offline`. No snapshot-diff "delivered" — a changed frame isn't proof the line landed; the drain is. Status rides the panel, not the pill: no double indicator. |
| `sent: false`, `holdReason: "low_confidence"` | `transcript` lands in the input bar as an ordinary draft — editable only because the field already is (no auto-focus, no keyboard pop, no special state). Sending it is a plain typed send: a user-reviewed transcript ≈ typed text, so no `source:"voice"` tagging in the viewer (hub + source support for the tag exists for future clients). |
| `sent: false`, `holdReason: "no_speech"` | Brief "didn't catch that" notice. Input bar untouched (the transcript may be hallucinated — never surface it). |
| Error (`400`/`404`/`503`, network) | Brief "voice unavailable" notice. Recording is discarded. |

## Notes

- **Toggle, not hold-to-talk** — commands are long; holding is fatiguing.
- **Recording**: `MediaRecorder`, default container per platform (mp4/AAC on iOS
  Safari — primary client; webm/opus elsewhere). POST raw blob to
  `/runs/:id/voice` with the stored hub secret. Cap length client-side (~2 min,
  under the 4 MiB body cap).
- **Synchronous**: one request covers transcribe + gate + queue; the UI blocks only
  the mic button (~2 s), never the stream view.
- Mic button visible only when the run is live (same condition as the input bar).
