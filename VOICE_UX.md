# Voice input — phone UX

Voice is the **primary input method**. On phones the mic is the **biggest key
in the touch-key row** (`↑ ↓ esc ⇧tab 🎙 ↵`) — the thumb's home row, sized above
the send key; on desktop (no key row) it's a keycap-class button next to the
field. Always visible while idle; **dimmed-disabled** when a draft (typed or
held transcript) owns the field, keeping the no-recording-over-a-draft rule
visible instead of vanishing. The text field stays *above* the key row: the
bottom edge belongs to the most-frequent controls, and while actually typing
the key row hides anyway (`kbd-active`) so the field docks to the keyboard. No gesture conflict: long-press on the text field keeps its
native iOS meaning (cursor placement, paste), which the held-transcript editing
flow depends on. Everything else reuses what's there (input
bar, send path, status pill, live stream). Scope matches the required `/voice` API
surface only — no waveform, no live partial transcript, no settings, no signals
display.

## States

```
idle ──tap──► recording ────────tap (= send)──► transcribing ──► resolved
 🎙            ✕   ● 0:07        [ tap to send ]   panel: "transcribing…"
               └cancel  └info (buffer)  └send
```

Cancel and send sit at **opposite ends** of the row, with the non-interactive
dot/timer/hint span between them as a physical buffer — so the destructive tap
can't be fat-fingered from the send tap (they were adjacent before, which felt
unsafe). Send owns the prime bottom-right thumb zone and is prominent (neutral,
not red); cancel is a small, dim, deliberate reach on the far left. The live
level ring (proof of capture) glows on the send button. Red appears only on the
recording dot and that faint ring — never on the send button itself.

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
| `sent: true` | Transcript **panel** above the input bar: the full wrapped transcript at reading size (cap ~5 lines, then internal scroll), shown the instant the response lands — it's your only look at what was heard (no live partial), so it appears immediately with **no delivery label**. It's one input in flight: the mic + input stay **frozen** (dimmed) while it's queued, and it holds until the hub queue drains (`pendingInputs → 0` — the source pulled it, the only reliable ack), never less than a min dwell (~2.5 s) so it stays readable, then fades and re-enables input. No "delivered" / "offline" status: a stuck input just stays blocked (the topbar heartbeat pill shows run liveness), and a changed frame isn't proof the line landed — the drain is. Typed prompts and composed key-batches serialize the same way. |
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
