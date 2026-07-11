// agent-stream viewer SPA.
//
// Hash-routed:
//   ''                          → top-level machine cards
//   '#machine/<host>'           → run cards for one machine, grouped by title
//   '#group/<machine>/<title>'  → list of streams (runs) within a group
//   '#<runId>'                  → live detail for one stream
//
// Detail view is one continuous stitched buffer per run. Stitcher.stitch
// handles snapshot-to-snapshot alignment; GAP markers from the stitcher
// render as inline dashed separators when a viewport jump can't align.
// No prompt markers / dividers — the viewer faithfully mirrors what the
// source's CLI rendered.

(function () {
  'use strict';

  // ---------- config ----------
  const POLL_LIST_MS = 5000;
  const POLL_DETAIL_LIVE_MS = 1500;
  const POLL_DETAIL_IDLE_MS = 10000;
  const HB_LIVE_MS = 60 * 1000;
  const HB_IDLE_MS = 10 * 60 * 1000;

  // ---------- state ----------
  let view = 'machines';
  let currentRunId = null;
  let currentMachine = null;
  let currentGroup = null;     // {host, title} when view === 'group'
  let runs = [];
  let runsLoaded = false;
  let buffer = [];             // stitched rows for the current run
  let historyLoaded = false;   // /history pulled once on enter? (per detail view)
  let currentLastSeenAt = null;
  let currentIsWorking = false;
  // Bumped on every user submission (key button OR typed prompt). Drives
  // adaptive polling — same shape as the source-side heartbeat: 200ms
  // immediately after a submit, doubling up to baseline within ~2s.
  let lastUserSubmitAt = 0;
  // Count of SUBSTANTIVE screen changes seen from polling — snapshots that
  // aren't ~identical to the previous one (the same near-duplicate test the
  // hub uses to compact spinner-frame churn). The default "did the agent
  // react" gate keys off this, not the raw snapshot seq, so a spinner tick or
  // a status-line second-counter (a one-row repaint) can't fake a reaction.
  // Captured at submit as contentSeqAtSubmit; a later increase = a real change.
  let contentSeq = 0;
  let contentSeqAtSubmit = 0;
  let prevPayloadRows = null;   // previous poll's snapshot rows, for the near-duplicate test
  // Synchronous re-entrancy guard for a submit in progress. Armed BEFORE the
  // /input POST's await and cleared in finally, so a second submit event
  // (double-tap ↵, iOS duplicate return) during the network round-trip can't
  // slip through and re-send. Typed input is fire-and-forget: cleared on send,
  // never held — so there's no stale value to re-read and no delivered-proxy
  // to get stuck on. (This replaced a check-before-await / set-after-await
  // gate whose gap allowed duplicate sends.)
  let submittingInput = false;
  // Debounce: source's `isWorking` flickers false during agent "thinking"
  // pauses between output bursts. We only flip the viewer's view to false
  // after it's been reported false for IS_WORKING_FALSE_GRACE_MS straight,
  // so the status pill and input bar don't bounce between states.
  let lastWorkingTrueAt = 0;
  const IS_WORKING_FALSE_GRACE_MS = 8000;
  let pollTimer = null;

  // ---------- bootstrap ----------
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // One-time secret seeding. A link of the form `?s=<secret>` stores the
    // secret and strips it from the URL — so the secret can be set by opening
    // a link once (no typing, no blocking prompt). Handy on phones.
    try {
      const sp = new URLSearchParams(location.search);
      const seeded = sp.get('s');
      if (seeded) {
        localStorage.setItem('agent-stream-secret', seeded.trim());
        history.replaceState(null, '', location.pathname + location.hash);
      }
    } catch (e) {}
    // Restore the "show stream markers" preference from localStorage.
    // Default is hidden — markers are diagnostic, off by default.
    if (localStorage.getItem('agent-stream-show-markers') === '1') {
      document.body.classList.add('show-markers');
    }
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling(); else kick();
    });
    onHashChange();
  }

  function onHashChange() {
    const hash = (location.hash || '').replace(/^#/, '');
    currentLastSeenAt = null;
    currentIsWorking = false;
    lastWorkingTrueAt = 0;
    lastPendingInputs = 0;
    lastUserSubmitAt = 0;
    contentSeq = 0;
    contentSeqAtSubmit = 0;
    prevPayloadRows = null;
    submittingInput = false;
    // Discard any in-flight state / composed batch belonging to the old view.
    typedPending = false;
    batchPending = false;
    keyPending = false;
    deliveredToSource = false;
    pendingMatchNeedle = '';
    batch = [];
    lastSentText = '';
    const inputEl = document.getElementById('input-bar-text');
    if (inputEl) { inputEl.readOnly = false; inputEl.value = ''; inputEl.classList.remove('pending'); }
    renderBatchLog();
    // Leaving the view mid-recording discards the take (interruption =
    // never send), and any chip belongs to the run we're leaving.
    if (voiceState === 'recording') stopRecording(false);
    voiceState = 'idle';
    hideVoiceChip();
    document.body.classList.remove('kbd-active');
    document.body.classList.remove('recording');     // defensive: clear if leaving mid-record
    document.body.classList.remove('input-pending');
    historyLoaded = false;
    currentRunId = null;
    currentMachine = null;
    currentGroup = null;
    buffer = [];
    if (hash.indexOf('machine/') === 0) {
      currentMachine = decodeURIComponent(hash.substring('machine/'.length));
      view = 'machine';
    } else if (hash.indexOf('group/') === 0) {
      const parts = hash.substring('group/'.length).split('/');
      if (parts.length >= 2) {
        currentGroup = { host: decodeURIComponent(parts[0]), title: decodeURIComponent(parts.slice(1).join('/')) };
        view = 'group';
      }
    } else if (hash) {
      currentRunId = decodeURIComponent(hash);
      view = 'detail';
    } else {
      view = 'machines';
    }
    renderShell();
    // Set the run's back target now. The runs list is already loaded when you
    // navigate in from a list (so we know the host); on a cold deep-link it's
    // empty for a moment and fetchList refreshes the link shortly after.
    updateDetailBackLink();
    kick();
  }

  function kick() {
    stopPolling();
    if (document.hidden) return;
    pollOnce().then(schedulePoll).catch((err) => {
      console.warn('poll err', err);
      schedulePoll();
    });
  }

  function schedulePoll() {
    stopPolling();
    if (document.hidden) return;
    let ms;
    if (view === 'detail') {
      // Adaptive: poll quickly right after a user submission so the
      // resulting CLI state shows up without waiting a baseline period.
      const since = Date.now() - lastUserSubmitAt;
      if      (since <  300) ms = 200;
      else if (since <  800) ms = 400;
      else if (since < 2000) ms = 800;
      else ms = currentIsWorking ? POLL_DETAIL_LIVE_MS : POLL_DETAIL_IDLE_MS;
    } else {
      ms = POLL_LIST_MS;
    }
    // A pending input is waiting to observe pickup + the agent's on-screen
    // reaction; keep polling brisk so we catch both on the real signal instead
    // of falling through to the 10s idle cadence (or the max-hold floor).
    if (anyPending() && ms > 800) ms = 800;
    pollTimer = setTimeout(kick, ms);
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  async function pollOnce() {
    if (view !== 'detail' || !runsLoaded) await fetchList();
    if (view === 'detail') {
      // First poll for this detail view: prime the buffer with the hub's
      // ring history so the user has immediate scrollback. The ring may
      // hold up to RING_CAP entries; stitching them oldest→newest gives
      // the same buffer the viewer would have if it had been polling
      // since the run started.
      if (!historyLoaded) {
        await loadHistoryIntoBuffer();
        historyLoaded = true;
      }
      await fetchLatest();
    }
  }

  async function loadHistoryIntoBuffer() {
    try {
      const res = await authFetch('/runs/' + encodeURIComponent(currentRunId) + '/history?limit=400');
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
      for (const e of entries) {
        const rows = (e && e.payload && e.payload.rows) || null;
        if (Array.isArray(rows)) buffer = Stitcher.stitch(buffer, rows);
      }
      renderDetailBuffer();
      // After replaying history, scroll to bottom so user lands on the latest.
      scrollGridToBottom();
    } catch (err) {
      console.warn('loadHistoryIntoBuffer', err);
    }
  }

  // Prompt for the secret at most ONCE per page load. The viewer polls every
  // few seconds; auto-prompting on every 401 would spam the blocking dialog
  // and (on iOS) make it impossible to even reach Add-to-Home-Screen. After a
  // single ask we stay quiet — a reload re-asks, or a `?s=` seed link sets it
  // silently with no dialog at all.
  let secretAsked = false;
  async function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {});
    const secret = localStorage.getItem('agent-stream-secret');
    if (secret) opts.headers['X-Hub-Secret'] = secret;
    let res = await fetch(url, opts);
    if (res.status === 401 && !secretAsked) {
      secretAsked = true;
      const entered = window.prompt('Hub secret:');
      if (entered) {
        const v = entered.trim();   // paste often carries a stray space/newline
        localStorage.setItem('agent-stream-secret', v);
        opts.headers['X-Hub-Secret'] = v;
        res = await fetch(url, opts);
      }
    }
    return res;
  }

  async function fetchList() {
    try {
      const res = await authFetch('/runs');
      const data = await res.json();
      runs = (data && data.runs) || [];
      runsLoaded = true;
      if (view === 'machines') renderMachinesList();
      else if (view === 'machine') renderMachineList();
      else if (view === 'group') renderGroupList();
      applyHueFromCurrentMeta();
      updateDetailBackLink();
    } catch (err) {
      runs = [];
      if (view !== 'detail') renderListError(err);
    }
  }

  function updateDetailBackLink() {
    if (view !== 'detail') return;
    const back = document.querySelector('.topbar .back');
    if (!back) return;
    const meta = runs.find((r) => r.runId === currentRunId);
    // Back goes up exactly one level: to the group page if there are
    // multiple streams sharing the same (host, title), else to the run's
    // machine (host) view. Only with no host/title do we fall to the top.
    if (meta && meta.host && meta.title) {
      const groupSiblings = runs.filter((r) => r.host === meta.host && (r.title || '') === (meta.title || ''));
      if (groupSiblings.length > 1) {
        back.setAttribute('href', '#group/' + encodeURIComponent(meta.host) + '/' + encodeURIComponent(meta.title));
        return;
      }
      back.setAttribute('href', '#machine/' + encodeURIComponent(meta.host));
      return;
    }
    back.setAttribute('href', '#');
  }

  async function fetchLatest() {
    if (!currentRunId) return;
    try {
      const res = await authFetch('/runs/' + encodeURIComponent(currentRunId) + '/latest');
      if (res.status === 404) {
        renderDetailGone();
        return;
      }
      const data = await res.json();
      currentLastSeenAt = (data && typeof data.lastSeenAt === 'number') ? data.lastSeenAt : null;
      updatePendingInputs(data && data.pendingInputs);
      const reportedWorking = !!(data && data.isWorking);
      if (reportedWorking) {
        currentIsWorking = true;
        lastWorkingTrueAt = Date.now();
      } else if (currentIsWorking) {
        // Sticky-true: hold the working state until we've been seeing false
        // for IS_WORKING_FALSE_GRACE_MS continuously. Smooths over brief
        // "thinking" pauses in agent output.
        if (Date.now() - lastWorkingTrueAt >= IS_WORKING_FALSE_GRACE_MS) {
          currentIsWorking = false;
        }
      }
      updateInputBarVisibility();
      const snap = data && data.snapshot;
      if (snap && snap.payload && Array.isArray(snap.payload.rows)) {
        const grid = document.getElementById('grid');
        const wasAtBottom = grid ? isAtBottom(grid) : true;
        // A snapshot that isn't ~identical to the last is a SUBSTANTIVE change
        // (not spinner/status churn) — advance the counter the default gate reads.
        if (!nearlyIdenticalRows(prevPayloadRows, snap.payload.rows)) contentSeq++;
        prevPayloadRows = snap.payload.rows;
        buffer = Stitcher.stitch(buffer, snap.payload.rows);
        renderDetailBuffer();
        if (wasAtBottom) scrollGridToBottom();
      }
      // Stand the in-flight input down once it lands: voice by its text on
      // screen, everything else by a substantive change after pickup.
      checkPendingLanded();
      updateTopbarPill();
      updateLatestFab();
    } catch (err) {
      console.warn('fetchLatest', err);
    }
  }

  function isAtBottom(el) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 16;
  }

  function scrollGridToBottom() {
    const grid = document.getElementById('grid');
    if (!grid) return;
    requestAnimationFrame(() => { grid.scrollTop = grid.scrollHeight; });
  }

  // ---------- shell ----------
  function renderShell() {
    const app = document.getElementById('app');
    if (view === 'machines') {
      app.innerHTML = `
        <header class="topbar">
          <span class="brand">agent-stream</span>
          <span style="flex:1"></span>
          <span class="pill" id="list-count"></span>
        </header>
        <div class="hue-divider"></div>
        <main class="list" id="list"><div class="empty">loading…</div></main>
      `;
    } else if (view === 'machine') {
      app.innerHTML = `
        <header class="topbar">
          <a class="back" href="#">←</a>
          <span class="run-title">${escapeHtml(currentMachine || '')}</span>
          <span class="pill" id="list-count"></span>
        </header>
        <div class="hue-divider"></div>
        <main class="list" id="list"><div class="empty">loading…</div></main>
      `;
    } else if (view === 'group') {
      app.innerHTML = `
        <header class="topbar">
          <a class="back" href="#machine/${encodeURIComponent(currentGroup ? currentGroup.host : '')}">←</a>
          <span class="run-title">${escapeHtml((currentGroup && currentGroup.title) || '')}</span>
          <span class="pill" id="list-count"></span>
        </header>
        <div class="hue-divider"></div>
        <main class="list" id="list"><div class="empty">loading…</div></main>
      `;
    } else {
      app.innerHTML = `
        <header class="topbar">
          <a class="back" href="#">←</a>
          <span class="run-title" id="run-title">loading…</span>
          <button class="markers-toggle" id="markers-toggle" type="button" title="Show / hide stream-marker hairlines (stitch + break boundaries)">markers</button>
          <span class="pill" id="status-pill"></span>
        </header>
        <div class="hue-divider"></div>
        <main class="grid" id="grid"></main>
        <!-- Voice transcript panel: shown from "hub accepted" until the agent
             visibly reacts on screen (a text-changed snapshot), at which point
             the injected line is visible in the terminal itself and the panel
             hands off to it. Full wrapped transcript at reading size — during
             this window the transcript outranks terminal output. Also doubles
             as the transient voice notice ("didn't catch that"). -->
        <div class="voice-chip" id="voice-chip" hidden>
          <div class="voice-chip-text" id="voice-chip-text"></div>
          <div class="voice-chip-status" id="voice-chip-status"></div>
        </div>
        <form class="input-bar" id="input-bar" style="display:none">
          <!-- Anchored to the input bar's top edge (position:absolute, bottom:
               100%) so it floats just above the keys regardless of how tall the
               bar is — no fixed offset to collide with. -->
          <button class="latest-fab" id="latest-fab" type="button" hidden>↓ Latest</button>
          <!-- The reply field. On phone it's hidden until you tap "Type" in the
               overflow; then it shows full-width and docks to the keyboard. -->
          <div class="input-wrap" id="input-wrap">
            <input class="input-bar-text" id="input-bar-text" type="text"
                   placeholder="Type to reply, Enter to send · empty + arrow/Tab/Esc → picker keys"
                   enterkeyhint="send" autocomplete="off" />
          </div>
          <!-- Voice is the primary input method: a full keycap-sized target
               next to the field (44px-class, thumb zone), not a glyph tucked
               inside it. Dimmed-disabled (not hidden) while a draft owns the
               field — the no-recording-over-a-draft rule stays visible. -->
          <button type="button" class="voice-mic" id="voice-mic" aria-label="Record a voice command" hidden>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3"/>
              <path d="M5 11a7 7 0 0 0 14 0"/>
              <line x1="12" y1="18" x2="12" y2="21"/>
            </svg>
          </button>
          <!-- Recording state: replaces the input while recording. Cancel
               and send sit at OPPOSITE ends with the (non-interactive) dot/
               timer/hint span between them as a physical buffer — so the
               destructive tap can't be fat-fingered from the send tap. Send
               owns the prime bottom-right thumb zone; cancel is a small, dim,
               deliberate reach on the far left. Level ring (live mic samples —
               proof of capture) glows on the send button (voice-ux.md). -->
          <div class="voice-rec" id="voice-rec" hidden>
            <button type="button" class="rec-cancel" id="rec-cancel" aria-label="Discard recording">✕</button>
            <span class="rec-info">
              <span class="rec-dot"></span>
              <span class="rec-time" id="rec-time">0:00</span>
              <span class="rec-hint" id="rec-hint"></span>
            </span>
            <button type="button" class="rec-send" id="rec-send" aria-label="Stop and send">tap to send</button>
          </div>
          <!-- Batch state hook (kept for the batch model; the visible feedback
               is the count badge on ↓, not a chip strip). -->
          <span class="key-log" id="key-log" hidden></span>
          <!-- One compact control row (phone): [🎙 / ✕] [↓·badge] [^C] [⋯ / send].
               Voice is primary (icon, a touch wider); ↓ composes and carries the
               batch count; ^C stays for one-tap interrupt; the overflow (⋯) holds
               Type / esc / ⇧tab. While composing, 🎙→✕ (discard) and ⋯→send.
               Hidden on desktop, where keyboard capture drives pickers. -->
          <div class="main-keys" id="main-keys">
            <button type="button" class="tkey tkey-mic" id="voice-mic-key" aria-label="Record a voice command" hidden>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3"/>
                <path d="M5 11a7 7 0 0 0 14 0"/>
                <line x1="12" y1="18" x2="12" y2="21"/>
              </svg>
            </button>
            <button type="button" class="tkey tkey-abort" id="batch-abort" aria-label="Discard the composed keys">✕</button>
            <button type="button" class="tkey tkey-down" data-key="ArrowDown" aria-label="Down">↓<span class="key-badge" id="down-badge" hidden></span></button>
            <button type="button" class="tkey tkey-int" data-key="CtrlC" aria-label="Interrupt (Ctrl-C)">^C</button>
            <button type="button" class="tkey tkey-more" id="more-key" aria-label="More keys" aria-expanded="false">⋯</button>
            <button type="submit" class="tkey tkey-go" aria-label="Send">send</button>
          </div>
          <!-- Overflow, floating above the ⋯ key: the rarely-pressed keys. -->
          <div class="overflow-menu" id="overflow-menu" hidden>
            <button type="button" class="tkey ov-key" id="type-key" aria-label="Type a reply">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="2" y="6" width="20" height="12" rx="2"/>
                <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>
              </svg>
              <span>Type</span>
            </button>
            <button type="button" class="tkey ov-key" data-key="Escape" aria-label="Escape">esc</button>
            <button type="button" class="tkey ov-key" data-key="ShiftTab" aria-label="Shift+Tab">⇧tab</button>
          </div>
        </form>
      `;
      document.getElementById('input-bar').addEventListener('submit', onInputBarSubmit);
      // Wire the picker-key buttons. Each click POSTs a raw byte string
      // that the source's onInputs branches on (charCodeAt(0) < 0x20 →
      // write verbatim, no auto-CR). Lets the user nudge a TUI picker
      // one step at a time and confirm independently.
      // Keyboard capture on the input field:
      //   · Printable chars + backspace → type into input as normal.
      //   · Arrow/Tab/Esc/etc. WHILE INPUT IS EMPTY → encode as raw
      //     ESC bytes and POST to source. Lets the user drive any TUI
      //     picker. With typed text present, those keys do their normal
      //     in-input cursor/focus action.
      //   · Enter → existing form submit, BUT blocked while a submit
      //     is still in flight (gates the picker against double-firing).
      //   · Modifier combos (Cmd/Ctrl/Alt) → always passed through.
      const inputEl = document.getElementById('input-bar-text');
      if (inputEl) {
        inputEl.addEventListener('keydown', onInputKeydown);
        // While the field is focused (keyboard up) hide the picker-key row:
        // you don't need it to type, and the keyboard's own return submits.
        inputEl.addEventListener('focus', () => document.body.classList.add('kbd-active'));
        inputEl.addEventListener('blur', () => document.body.classList.remove('kbd-active'));
        if (matchMedia('(pointer: coarse)').matches) {
          // Parallel verb to "Speak"; the keyboard glyph carries the rest.
          inputEl.placeholder = 'Type a reply…';
        } else {
          // Don't auto-pop the keyboard on touch devices — it would cover the
          // picker + content and hide the picker keys. Desktop keeps autofocus.
          setTimeout(() => inputEl.focus(), 0);
        }
      }
      // Touch keys (phone): ↓ composes; esc/⇧tab (overflow) + ^C fire
      // immediately. "send" (submit) flushes the batch; ✕ discards it. Any
      // overflow key press closes the overflow.
      document.querySelectorAll('#input-bar .tkey[data-key]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const k = btn.getAttribute('data-key');
          const bytes = KEYDOWN_BYTES[k];
          if (bytes) pressKey(k, bytes, KEYDOWN_LABEL[k] || k, btn);
          closeOverflow();
        });
      });
      const abortBtn = document.getElementById('batch-abort');
      if (abortBtn) abortBtn.addEventListener('click', abortBatch);
      const moreBtn = document.getElementById('more-key');
      if (moreBtn) moreBtn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleOverflow(); });
      const typeBtn = document.getElementById('type-key');
      if (typeBtn) typeBtn.addEventListener('click', openTyping);
      // One document listener (guarded) closes the overflow on an outside tap.
      if (!overflowCloserWired) {
        document.addEventListener('click', (ev) => {
          const menu = document.getElementById('overflow-menu');
          const more = document.getElementById('more-key');
          if (menu && !menu.hidden && !menu.contains(ev.target) && more !== ev.target && !(more && more.contains(ev.target))) closeOverflow();
        });
        overflowCloserWired = true;
      }
      wireVoice();
      // Escape route: tap the pending feedback (voice panel or the frozen input
      // field) to abort the freeze. The input was already sent — this only
      // dismisses the local hold so you can act again without waiting the floor.
      const voiceChipEl = document.getElementById('voice-chip');
      if (voiceChipEl) voiceChipEl.addEventListener('click', () => { if (anyPending()) tearDownPending(); });
      const pendField = document.getElementById('input-bar-text');
      if (pendField) pendField.addEventListener('click', () => { if (anyPending()) tearDownPending(); });
      const grid = document.getElementById('grid');
      if (grid) grid.addEventListener('scroll', updateLatestFab, { passive: true });
      const fab = document.getElementById('latest-fab');
      if (fab) fab.addEventListener('click', () => { scrollGridToBottom(); fab.hidden = true; });
      const markersToggle = document.getElementById('markers-toggle');
      if (markersToggle) markersToggle.addEventListener('click', () => {
        const on = document.body.classList.toggle('show-markers');
        localStorage.setItem('agent-stream-show-markers', on ? '1' : '0');
      });
    }
    applyHueFromCurrentMeta();
  }

  function updateLatestFab() {
    if (view !== 'detail') return;
    const fab = document.getElementById('latest-fab');
    const grid = document.getElementById('grid');
    if (!fab || !grid) return;
    fab.hidden = isAtBottom(grid);
  }

  // Keyboard-capture map: KeyboardEvent.key → raw bytes to write to PTY.
  // Source recognizes control-byte inputs (< 0x20) and writes them
  // verbatim without auto-CR, so each press moves the cursor without
  // committing. Enter is handled separately via the form submit handler.
  const KEYDOWN_BYTES = {
    'ArrowUp':    '\x1b[A',
    'ArrowDown':  '\x1b[B',
    'ArrowLeft':  '\x1b[D',
    'ArrowRight': '\x1b[C',
    'Tab':        '\t',
    // Back-tab (CSI Z). Claude Code's mode toggle — the touch row exposes
    // this instead of plain Tab; far more useful from a phone.
    'ShiftTab':   '\x1b[Z',
    // Ctrl-C / SIGINT (ETX). Interrupts the running command or agent. As a
    // control byte (< 0x20) the source writes it verbatim, no auto-CR.
    'CtrlC':      '\x03',
    'Escape':     '\x1b',
    'PageUp':     '\x1b[5~',
    'PageDown':   '\x1b[6~',
    'Home':       '\x1b[H',
    'End':        '\x1b[F',
  };
  // Glyphs rendered in the key-log chip strip next to the input.
  // Compact representations of what we actually sent to the source.
  const KEYDOWN_LABEL = {
    'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowLeft': '←', 'ArrowRight': '→',
    'Tab': 'Tab', 'ShiftTab': '⇧Tab', 'CtrlC': '^C', 'Escape': 'Esc',
    'PageUp': 'PgUp', 'PageDown': 'PgDn', 'Home': 'Home', 'End': 'End',
  };
  function onInputKeydown(ev) {
    // Modifier combos: never intercept (browser shortcuts).
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const input = ev.currentTarget;

    // Enter falls through to the form submit (flush batch / send typed).
    if (ev.key === 'Enter') return;
    // Backspace on an empty field discards the whole composed batch.
    if (ev.key === 'Backspace' && input.value === '' && batch.length > 0) {
      ev.preventDefault();
      abortBatch();
      return;
    }
    const keyName = (ev.key === 'Tab' && ev.shiftKey) ? 'ShiftTab' : ev.key;
    const bytes = KEYDOWN_BYTES[keyName];
    if (!bytes) return;
    // Picker keys only intercept when the field is empty; otherwise the user is
    // editing typed text and arrow/Tab/etc. do their normal cursor thing.
    if (input.value !== '') return;
    ev.preventDefault();
    var touchBtn = document.querySelector('#input-bar .tkey[data-key="' + keyName + '"]');
    pressKey(keyName, bytes, KEYDOWN_LABEL[keyName] || keyName, touchBtn);
  }

  // ---------- picker-key batch ----------
  // Keys compose a local batch (not sent per-press) so the streamed menu stays
  // still while you count; the key-log shows the batch. "send" flushes it as one
  // input; ✕ discards the whole batch. Blocked while an input's in flight.
  function addToBatch(bytes, label) {
    if (!currentRunId || anyPending()) return;
    batch.push({ bytes: bytes, label: label });
    renderBatchLog();
  }
  function abortBatch() {
    if (anyPending() || !batch.length) return;
    batch = [];
    renderBatchLog();
  }
  // Control keys (esc / ⇧tab / ^C) are single actions — cancel, mode-toggle,
  // interrupt — not counted navigation, so they fire right away instead of
  // composing into the ↓ batch. Any uncommitted batch is discarded — the action
  // supersedes the nav you were counting. They then freeze like any other input
  // until they land, which (for ^C especially) makes a reflexive DOUBLE press
  // hard: a second ^C can kill the agent, so it should take a deliberate
  // dismiss-then-press, not a twitch.
  async function sendControlKey(bytes, label, flashEl) {
    if (!currentRunId || anyPending()) return;
    if (batch.length) { batch = []; renderBatchLog(); }
    flashKey(flashEl);
    try {
      await postInput(bytes);
      keyPending = true;
      showVoiceChip(label, '');   // show what was sent (tap to dismiss)
      freezeUi();
    } catch (err) {
      alert('Send failed: ' + ((err && err.message) || String(err)));
    }
  }
  // Brief highlight on a key when an immediate control action fires.
  function flashKey(el) {
    if (!el) return;
    el.classList.remove('sent-flash');
    void el.offsetWidth;   // restart the flash on a rapid re-press
    el.classList.add('sent-flash');
    setTimeout(function () { el.classList.remove('sent-flash'); }, 400);
  }
  // Arrows are counted navigation (compose); everything else is an immediate
  // control action (with a flash for feedback).
  function pressKey(keyName, bytes, label, flashEl) {
    if (keyName.indexOf('Arrow') === 0) addToBatch(bytes, label);
    else sendControlKey(bytes, label, flashEl);
  }
  // Key-log = batch preview: bright while composing; dimmed ("sent") while the
  // flushed batch waits to be picked up; cleared on drain. Pass sentLabels to
  // render the frozen post-flush state; no arg renders the live batch. Also
  // toggles `composing` (batch takes the field's slot; reveals "send") and the
  // ✕ abort (shown only while actively composing, not once flushed).
  function renderBatchLog(sentLabels) {
    const el = document.getElementById('key-log');
    if (!el) return;
    const labels = sentLabels || batch.map(function (b) { return b.label; });
    // Collapse runs of the same key so it stays compact in the small slot:
    // ↓ ↓ ↓ → "↓×3".
    const groups = [];
    for (let i = 0; i < labels.length; i++) {
      const last = groups[groups.length - 1];
      if (last && last.label === labels[i]) last.n++;
      else groups.push({ label: labels[i], n: 1 });
    }
    el.innerHTML = '';
    for (let g = 0; g < groups.length; g++) {
      const chip = document.createElement('span');
      chip.className = 'key-chip' + (sentLabels ? ' sent' : '');
      chip.textContent = groups[g].n > 1 ? groups[g].label + '×' + groups[g].n : groups[g].label;
      el.appendChild(chip);
    }
    el.classList.toggle('visible', labels.length > 0);
    document.body.classList.toggle('composing', labels.length > 0);
    // The visible batch feedback is a count badge on ↓ (only arrows compose,
    // so the count is the ↓ tally). Shown live and while the flushed batch
    // waits to drain; cleared on drain (renderBatchLog() with no arg, batch=[]).
    const badge = document.getElementById('down-badge');
    if (badge) {
      badge.textContent = labels.length > 1 ? String(labels.length) : '';
      badge.hidden = labels.length < 2;
    }
  }
  // Overflow (⋯): Type / esc / ⇧tab. Floats above the ⋯ key.
  let overflowCloserWired = false;
  function toggleOverflow() {
    const menu = document.getElementById('overflow-menu');
    const more = document.getElementById('more-key');
    if (!menu) return;
    const show = menu.hidden;
    menu.hidden = !show;
    if (more) more.setAttribute('aria-expanded', show ? 'true' : 'false');
  }
  function closeOverflow() {
    const menu = document.getElementById('overflow-menu');
    const more = document.getElementById('more-key');
    if (menu && !menu.hidden) menu.hidden = true;
    if (more) more.setAttribute('aria-expanded', 'false');
  }
  // "Type" (overflow): reveal the field and pop the keyboard. body.kbd-active
  // hides the key row so the field docks to the keyboard.
  function openTyping() {
    closeOverflow();
    const inputEl = document.getElementById('input-bar-text');
    if (!inputEl) return;
    document.body.classList.add('kbd-active');
    inputEl.focus();
  }
  // Dim + block the touch rows while an input's in flight — the visible
  // "frozen, wait" cue (the anyPending() guards do the real blocking). An input
  // entering flight starts at stage 1 (queued) and arms the max-hold floor
  // here; tearing it down (thawUi) resets the gate and cancels the floor.
  function freezeUi() {
    document.body.classList.add('input-pending');
    deliveredToSource = false;
    updateMicVisibility();
  }
  function thawUi() {
    document.body.classList.remove('input-pending');
    deliveredToSource = false;
    pendingMatchNeedle = '';
    updateMicVisibility();
  }

  async function postInput(prompt) {
    const res = await authFetch('/runs/' + encodeURIComponent(currentRunId) + '/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    lastUserSubmitAt = Date.now();
    contentSeqAtSubmit = contentSeq;
    kick();
  }

  // Flush the composed batch (+ a confirming CR) as one input, then freeze
  // until it lands. Empty batch → a bare confirm.
  async function flushBatch() {
    if (!currentRunId) return;
    const labels = batch.map(function (b) { return b.label; }).concat('↵');
    const bytes = batch.map(function (b) { return b.bytes; }).join('') + '\r';
    try {
      await postInput(bytes);
      batch = [];
      batchPending = true;
      renderBatchLog();                            // clear the compose UI
      showVoiceChip(summarizeLabels(labels), '');  // show what was sent (tap to dismiss)
      freezeUi();
    } catch (err) {
      alert('Send failed: ' + ((err && err.message) || String(err)));
    }
  }

  // Typed prompt: send, then hold the text (dimmed, read-only) until the source
  // pulls it — one prompt in flight.
  async function sendTyped(value) {
    if (!currentRunId) return;
    const input = document.getElementById('input-bar-text');
    try {
      await postInput(value);
      typedPending = true;
      lastSentText = value;
      if (input) { input.readOnly = true; input.classList.add('pending'); }
      // Typed rides the default seq gate (freezeUi below) — NOT content-match:
      // a bare Enter (empty submit → CR) has no text to match, and typing is
      // secondary to voice anyway, so it's not worth a special path.
      freezeUi();
    } catch (err) {
      alert('Send failed: ' + ((err && err.message) || String(err)));
    }
  }

  async function onInputBarSubmit(ev) {
    ev.preventDefault();
    if (submittingInput) return;   // re-entrancy guard for the POST round-trip
    if (anyPending()) return;      // one input in flight until the source pulls it
    if (!currentRunId) return;
    const input = document.getElementById('input-bar-text');
    const value = (input && input.value || '').trim();
    // Phone: dismiss the keyboard on submit — return alone should finish the
    // interaction. Done synchronously inside the gesture's call stack (before
    // any await) — iOS can ignore focus changes from async continuations.
    if (input && matchMedia('(pointer: coarse)').matches) input.blur();
    submittingInput = true;
    try {
      // A composed picker batch wins; else a typed prompt; else a bare confirm.
      if (batch.length > 0) await flushBatch();
      else if (value) await sendTyped(value);
      else await flushBatch();   // empty batch → \r
    } finally {
      submittingInput = false;
    }
  }

  // Input bar is always visible. State signal lives in the topbar pill.
  function updateInputBarVisibility() {
    const bar = document.getElementById('input-bar');
    if (bar) bar.style.display = '';
  }

  // ---------- voice input (voice-ux.md) ----------
  // idle → recording (toggle; level ring proves capture) → transcribing →
  // transcript panel (held until delivered or "not delivered · agent offline")
  // | held (transcript becomes an ordinary draft in the input field)
  // | no_speech / error (transient notice).
  const REC_CAP_MS = 120 * 1000;   // client cap, under the hub's 4 MiB body cap
  const REC_WARN_MS = 100 * 1000;  // amber countdown for the last 20 s
  let voiceState = 'idle';         // idle | recording | transcribing
  let recStream = null;
  let recRecorder = null;
  let recChunks = [];
  let recAudioCtx = null;
  let recTicker = null;
  let recStartAt = 0;
  let recHeardAnything = false;
  let recSendOnStop = false;
  let voiceChipFadeTimer = null;
  // One input in flight at a time. Something is "pending" from when you send it
  // until the hub queue drains (the source pulled it — the only reliable ack).
  // While pending, all input is blocked and the sent thing stays visible; on
  // drain it clears and re-enables. No offline diagnosis — a stuck input just
  // stays blocked (the topbar heartbeat pill shows run liveness separately).
  //   · voice  → the transcript panel (min dwell so it stays readable)
  //   · type   → the sent text, held dimmed in the field
  //   · batch  → the composed picker keys, shown in the key-log
  let voicePending = false;
  let typedPending = false;
  let batchPending = false;
  let lastSentText = '';   // the in-flight typed prompt, held in the field until torn down
  let voiceChipShownAt = 0;
  const VOICE_CHIP_MIN_DWELL_MS = 2500;
  // Every phone input (voice transcript, typed text, composed batch) keeps its
  // pending feedback up through a two-stage delivery gate, then tears down:
  //   stage 1 — QUEUED:    POSTed, sitting in the hub queue.
  //   stage 2 — DELIVERED: the source drained the queue (count → 0) and wrote
  //                        our bytes to the PTY; deliveredToSource flips true.
  //   done            — a text-changed snapshot arrives AFTER delivery (newer
  //                        seq; renderer-watch only emits on a real text change)
  //                        → the agent has our input on screen.
  // Ordering matters: gating on the screen change alone would trip on a screen
  // already churning from prior work, tearing feedback down before our input
  // was even delivered — and gating on the drain alone is too early, since the
  // source pulls the bytes a beat before the CLI paints them, leaving a blank
  // gap.
  //
  // VOICE — the primary input — watches for the spoken text to appear in the
  // rendered screen (checkPendingLanded → content-match): a direct, churn-proof
  // "my words landed" signal. Everything else uses the default gate: pickup
  // (the hub queue drains) then a SUBSTANTIVE screen change (contentSeq — a
  // snapshot not ~identical to the last, so spinner/status churn is filtered).
  // That covers typed (incl. a bare Enter), composed arrows, and the control
  // keys ^C/esc/⇧tab (which freeze too — making a reflexive double-^C hard).
  //
  // There is NO auto-teardown timer: a pending input holds until it lands or
  // you dismiss it. Every freeze shows WHAT was sent and is tap-to-dismiss —
  // the voice panel (voice / batch / control) or the sent text in the field
  // (typed) — so an offline or never-landing input is escaped by hand, never
  // stranded.
  let deliveredToSource = false;
  let keyPending = false;         // an immediate control key (^C/esc/⇧tab) in flight
  let pendingMatchNeedle = '';    // whitespace-stripped spoken text to look for (voice)
  let pendingMatchBaseline = 0;   // its occurrence count on screen at submit; a NEW one = landed
  function anyPending() { return voicePending || typedPending || batchPending || keyPending; }
  // Picker keys are composed here (held, not sent per-press) so the streamed
  // menu stays still while you count; ↵ flushes the batch as one input.
  let batch = [];   // [{ bytes, label }]

  function voiceSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function wireVoice() {
    const mic = document.getElementById('voice-mic');
    if (!mic || !voiceSupported()) return;
    mic.hidden = false;
    mic.addEventListener('click', () => { if (voiceState === 'idle') startRecording(); });
    const micKey = document.getElementById('voice-mic-key');
    if (micKey) {
      micKey.hidden = false;
      micKey.addEventListener('click', () => { if (voiceState === 'idle') startRecording(); });
    }
    document.getElementById('rec-send').addEventListener('click', () => stopRecording(true));
    document.getElementById('rec-cancel').addEventListener('click', () => stopRecording(false));
    // Mic only when the field is empty — text present means a draft (typed
    // or a held transcript) owns the bar; no recording over an unsent draft.
    const input = document.getElementById('input-bar-text');
    if (input) input.addEventListener('input', updateMicVisibility);
    // Interruption = discard, never send: an interrupted take is a
    // half-command the confidence gate can't recognize as such.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && voiceState === 'recording') {
        stopRecording(false);
        voiceNotice('recording canceled');
      }
    });
    updateMicVisibility();
  }

  function updateMicVisibility() {
    const mic = document.getElementById('voice-mic');
    const input = document.getElementById('input-bar-text');
    if (!mic || !voiceSupported()) return;
    // Hidden only while the recording UI owns the row; otherwise disabled
    // (dimmed, no layout jump) when either a draft owns the field (no recording
    // over a draft) OR a previous voice is still queued at the hub — one voice
    // in flight at a time: send it, let the source pull it, then record next.
    const hidden = voiceState !== 'idle';
    const disabled = !!(input && input.value !== '') || anyPending();
    mic.hidden = hidden;
    mic.disabled = disabled;
    const micKey = document.getElementById('voice-mic-key');
    if (micKey) { micKey.hidden = hidden; micKey.disabled = disabled; }
  }

  async function startRecording() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      voiceNotice('mic permission needed');
      return;
    }
    recStream = stream;
    recChunks = [];
    recHeardAnything = false;
    recSendOnStop = false;
    // No mimeType: take the platform default (mp4/AAC on iOS Safari,
    // webm/opus elsewhere) — the hub's ffmpeg sniffs the container.
    recRecorder = new MediaRecorder(stream);
    recRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
    recRecorder.onstop = onRecorderStop;
    recRecorder.onerror = () => { stopRecording(false); voiceNotice('recording failed'); };
    recRecorder.start();
    recStartAt = Date.now();
    voiceState = 'recording';
    // A previous transcript may still be fading (its gate cleared, releasing the
    // mic, but the panel lingers for its min dwell) — clear it before the ring.
    hideVoiceChip();
    setRecUiVisible(true);
    updateMicVisibility();
    // Live level → ring on the send control. Driven by the actual samples
    // so a dead mic is visibly wrong within seconds, not after the take.
    let analyser = null;
    try {
      recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = recAudioCtx.createMediaStreamSource(stream);
      analyser = recAudioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
    } catch (e) { /* level ring is feedback, not load-bearing */ }
    const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
    recTicker = setInterval(() => {
      const elapsed = Date.now() - recStartAt;
      const timeEl = document.getElementById('rec-time');
      if (timeEl) {
        if (elapsed >= REC_WARN_MS) {
          const left = Math.max(0, Math.ceil((REC_CAP_MS - elapsed) / 1000));
          timeEl.textContent = '0:' + String(left).padStart(2, '0') + ' left';
          timeEl.classList.add('warn');
        } else {
          const s = Math.floor(elapsed / 1000);
          timeEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
          timeEl.classList.remove('warn');
        }
      }
      let level = 0;
      if (analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
        level = Math.sqrt(sum / buf.length);            // 0..~1 RMS
        if (level > 0.02) recHeardAnything = true;
      }
      const send = document.getElementById('rec-send');
      if (send) send.style.setProperty('--lvl', String(Math.min(1, level * 6)));
      const hint = document.getElementById('rec-hint');
      if (hint) hint.textContent = (!recHeardAnything && elapsed > 3000 && analyser) ? "can't hear you" : '';
      // At the cap: stop and transcribe — never discard intentional speech.
      if (elapsed >= REC_CAP_MS) stopRecording(true);
    }, 100);
  }

  function stopRecording(send) {
    if (voiceState !== 'recording') return;
    recSendOnStop = !!send;
    voiceState = send ? 'transcribing' : 'idle';
    if (recTicker) { clearInterval(recTicker); recTicker = null; }
    try { recRecorder.stop(); } catch (e) { onRecorderStop(); }
    setRecUiVisible(false, send);
    updateMicVisibility();
  }

  function onRecorderStop() {
    const chunks = recChunks;
    recChunks = [];
    const type = (recRecorder && recRecorder.mimeType) || 'application/octet-stream';
    // Teardown before the network round-trip — release the mic promptly
    // (kills iOS's orange dot as soon as recording ends).
    if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
    if (recAudioCtx) { recAudioCtx.close().catch(() => {}); recAudioCtx = null; }
    recRecorder = null;
    if (!recSendOnStop) return;
    postVoice(new Blob(chunks, { type }));
  }

  async function postVoice(blob) {
    if (!currentRunId || !blob.size) { voiceState = 'idle'; setRecUiVisible(false); hideVoiceChip(); updateMicVisibility(); return; }
    try {
      const res = await authFetch('/runs/' + encodeURIComponent(currentRunId) + '/voice', {
        method: 'POST',
        body: blob,
      });
      if (!res.ok) {
        voiceNotice(res.status === 503 ? 'voice unavailable' : 'voice failed (' + res.status + ')');
        return;
      }
      const data = await res.json();
      if (data.sent) {
        // The transcript is your first (and only) look at what was heard —
        // show it immediately, no delivery label. Like every phone input it
        // holds until the source has picked it up AND the agent has visibly
        // taken it on screen (updatePendingInputs), then fades — long enough to
        // read; the mic + input stay frozen until then (one in flight).
        showVoiceChip(data.transcript, '');
        voicePending = true;
        voiceChipShownAt = Date.now();
        lastPendingInputs = Math.max(1, lastPendingInputs + 1);
        lastUserSubmitAt = Date.now();
        contentSeqAtSubmit = contentSeq;
        armPendingMatch(data.transcript);   // stand down when the words show on screen
        freezeUi();
        kick();
      } else if (data.holdReason === 'no_speech') {
        voiceNotice("didn't catch that");
      } else {
        // low_confidence: the transcript becomes an ordinary draft in the
        // input field — editable because the field already is; no focus,
        // no special state. Sending it is a plain typed send.
        const input = document.getElementById('input-bar-text');
        if (input && !input.readOnly && input.value === '') {
          input.value = data.transcript;
          updateMicVisibility();
          voiceNotice('not sure I heard right — review & send');
        } else {
          voiceNotice('held: ' + data.transcript);
        }
      }
    } catch (err) {
      voiceNotice('voice failed');
    } finally {
      if (voiceState === 'transcribing') voiceState = 'idle';
      setRecUiVisible(false);
      updateMicVisibility();
    }
  }

  function setRecUiVisible(recording, transcribing) {
    const rec = document.getElementById('voice-rec');
    const wrap = document.getElementById('input-wrap');
    const send = document.getElementById('rec-send');
    if (rec) rec.hidden = !recording;
    if (wrap) wrap.hidden = !!recording;
    if (send && recording) send.style.setProperty('--lvl', '0');
    // Hide the touch-key row while recording: mid-recording its picker/↵ keys
    // would send stray bytes to the PTY, and the mic key is a no-op. Only the
    // recording row (cancel/send) should be reachable. Same treatment as
    // keyboard-up (body.kbd-active).
    document.body.classList.toggle('recording', !!recording);
    // "transcribing…" readout in the panel while the round trip runs.
    if (!recording && transcribing) showVoiceChip('', 'transcribing…');
  }

  // Transcript panel: full wrapped text at reading size. The status row is
  // only used for the pre-transcript "transcribing…" pulse; the transcript
  // itself shows with no delivery label (fire-and-forget). Also doubles as
  // the transient notice (auto-fade). Held/faded by updatePendingInputs.
  function showVoiceChip(text, status) {
    const chip = document.getElementById('voice-chip');
    const textEl = document.getElementById('voice-chip-text');
    const statusEl = document.getElementById('voice-chip-status');
    if (!chip || !textEl || !statusEl) return;
    if (voiceChipFadeTimer) { clearTimeout(voiceChipFadeTimer); voiceChipFadeTimer = null; }
    textEl.textContent = text;
    textEl.hidden = !text;
    statusEl.textContent = status || '';
    statusEl.hidden = !status;
    chip.classList.toggle('sending', !!status);
    chip.classList.remove('failed');
    chip.hidden = false;
  }
  function voiceNotice(text) {
    showVoiceChip(text, '');
    voiceChipFadeTimer = setTimeout(() => hideVoiceChip(), 4000);
  }
  function hideVoiceChip() {
    voicePending = false;
    updateMicVisibility();   // re-enable the mic once no voice is in flight
    const chip = document.getElementById('voice-chip');
    if (!chip) return;
    chip.hidden = true;
    chip.classList.remove('failed', 'sending');
    const textEl = document.getElementById('voice-chip-text');
    const statusEl = document.getElementById('voice-chip-status');
    if (textEl) textEl.textContent = '';
    if (statusEl) statusEl.textContent = '';
  }

  // Start the readable-fade countdown for the voice panel: hide once the min
  // dwell has elapsed since it appeared (so it stays readable even if the
  // screen changed right away). The typed field and batch chips carry no such
  // reading cost, so tearDownPending clears them at once.
  function fadeVoiceChipReadable() {
    if (voiceChipFadeTimer) clearTimeout(voiceChipFadeTimer);
    const wait = Math.max(0, VOICE_CHIP_MIN_DWELL_MS - (Date.now() - voiceChipShownAt));
    voiceChipFadeTimer = setTimeout(hideVoiceChip, wait);
  }
  // Two snapshots are "nearly identical" — spinner/status churn, not a real
  // change — when they have the same row count and ≥90% of rows share text. The
  // same near-duplicate test the hub uses to compact churn; here it filters the
  // default gate so a one-row repaint doesn't read as the agent reacting.
  function nearlyIdenticalRows(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    if (a.length === 0) return true;
    let same = 0;
    for (let i = 0; i < a.length; i++) {
      if (((a[i] && a[i].text) || '') === ((b[i] && b[i].text) || '')) same++;
    }
    return same / a.length >= 0.9;
  }
  // Collapse a run of sent key labels for the "what was sent" chip: ↓↓↓↵ → "↓×3 ↵".
  function summarizeLabels(labels) {
    const groups = [];
    for (let i = 0; i < labels.length; i++) {
      const last = groups[groups.length - 1];
      if (last && last.label === labels[i]) last.n++;
      else groups.push({ label: labels[i], n: 1 });
    }
    return groups.map(function (g) { return g.n > 1 ? g.label + '×' + g.n : g.label; }).join(' ');
  }
  // The rendered screen as one whitespace-stripped, lowercased string. Stripping
  // whitespace makes the match robust to soft-wrapping (a word split across two
  // rows rejoins) and to indentation.
  function screenNeedleText() {
    let s = '';
    for (let i = 0; i < buffer.length; i++) {
      const r = buffer[i];
      if (r && !r.break_ && !r.stitch) s += (r.text || '');
    }
    return s.toLowerCase().replace(/\s+/g, '');
  }
  function occurrences(hay, needle) {
    if (!needle) return 0;
    let c = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length; }
    return c;
  }
  // Arm a text-match teardown for a voice transcript: remember the spoken text
  // (whitespace-stripped) and how many times it's ALREADY on screen, so that a
  // NEW occurrence — the agent echoing/taking our words — is what stands the
  // feedback down. Too-short text is ambiguous (would match incidentally), so it
  // falls through to the delivery + seq gate instead.
  function armPendingMatch(text) {
    const needle = (text || '').toLowerCase().replace(/\s+/g, '');
    if (needle.length < 4) { pendingMatchNeedle = ''; pendingMatchBaseline = 0; return; }
    pendingMatchNeedle = needle;
    pendingMatchBaseline = occurrences(screenNeedleText(), needle);
  }
  // Called after each buffer update — the moment an in-flight input may have
  // landed:
  //   · voice   → a fresh occurrence of the spoken text on screen
  //   · default → a substantive screen change (contentSeq) after pickup
  function checkPendingLanded() {
    if (!anyPending()) return;
    if (pendingMatchNeedle) {
      if (occurrences(screenNeedleText(), pendingMatchNeedle) > pendingMatchBaseline) {
        pendingMatchNeedle = '';
        tearDownPending();
      }
      return;
    }
    if (deliveredToSource && contentSeq > contentSeqAtSubmit) tearDownPending();
  }
  // Stand the in-flight input down once it lands (or you tap to dismiss). Voice
  // fades over its min dwell so it stays readable; the typed field, and the
  // "what was sent" panel for batch/control, clear at once. thawUi re-enables
  // input. No timer: if it never lands, the manual escape is the only exit.
  function tearDownPending() {
    lastUserSubmitAt = 0;   // end the fast-poll burst
    if (voicePending) { voicePending = false; fadeVoiceChipReadable(); }
    if (typedPending) {
      typedPending = false;
      const input = document.getElementById('input-bar-text');
      if (input) {
        if (lastSentText && input.value === lastSentText) input.value = '';
        input.readOnly = false;
        input.classList.remove('pending');
      }
      lastSentText = '';
    }
    if (batchPending) { batchPending = false; renderBatchLog(); hideVoiceChip(); }
    if (keyPending) { keyPending = false; hideVoiceChip(); }
    thawUi();
  }

  // On each /latest poll: just track pickup (the hub queue draining to 0 = the
  // source pulled our bytes). The teardown itself runs in checkPendingLanded
  // after the buffer updates — voice by its text, the rest by a substantive
  // change once this pickup flag is set.
  let lastPendingInputs = 0;
  function updatePendingInputs(count) {
    const n = typeof count === 'number' ? count : 0;
    lastPendingInputs = n;
    if (!anyPending()) return;
    if (!deliveredToSource && n === 0) deliveredToSource = true;
  }

  function applyHueFromCurrentMeta() {
    const root = document.documentElement;
    let hue = null;
    if (view === 'detail' && currentRunId) {
      const meta = runs.find((r) => r.runId === currentRunId);
      if (meta && typeof meta.hue === 'number') hue = meta.hue;
    }
    if (hue !== null) root.style.setProperty('--hue', `oklch(65% 0.27 ${hue})`);
    else root.style.removeProperty('--hue');
  }

  // ---------- machines view (top-level) ----------
  function renderMachinesList() {
    const el = document.getElementById('list');
    const countEl = document.getElementById('list-count');
    if (!el) return;
    const machines = groupAndSortMachines(runs);
    if (countEl) countEl.textContent = machines.length + (machines.length === 1 ? ' machine' : ' machines');
    if (machines.length === 0) {
      el.innerHTML = '<div class="empty">No active runs. Submit a prompt in agent-term to see one here.</div>';
      return;
    }
    el.innerHTML = machines.map(machineCard).join('');
  }

  function groupAndSortMachines(runList) {
    const map = new Map();
    for (const r of runList) {
      const host = r.host || 'unknown';
      if (!map.has(host)) map.set(host, []);
      map.get(host).push(r);
    }
    const machines = [];
    map.forEach((hostRuns, host) => {
      let yourTurnCount = 0;
      let oldestYourTurn = null;
      let newestLastSeen = 0;
      for (const r of hostRuns) {
        const st = cardState(r);
        if (st.kind === 'your_turn') {
          yourTurnCount++;
          if (r.lastSeenAt && (oldestYourTurn === null || r.lastSeenAt < oldestYourTurn)) {
            oldestYourTurn = r.lastSeenAt;
          }
        }
        if (r.lastSeenAt && r.lastSeenAt > newestLastSeen) newestLastSeen = r.lastSeenAt;
      }
      machines.push({ host, runs: hostRuns, yourTurnCount, oldestYourTurn, newestLastSeen });
    });
    return machines.sort((a, b) => {
      const aPri = a.yourTurnCount > 0 ? 0 : 1;
      const bPri = b.yourTurnCount > 0 ? 0 : 1;
      if (aPri !== bPri) return aPri - bPri;
      return a.host.localeCompare(b.host);
    });
  }

  function machineCard(m) {
    const hb = heartbeatState(m.newestLastSeen || null);
    const lastSeenLabel = m.newestLastSeen ? fmtAgo(m.newestLastSeen) : 'never';
    let yourTurnLine = '';
    if (m.yourTurnCount > 0) {
      const oldestLabel = m.oldestYourTurn ? fmtAgo(m.oldestYourTurn) : '';
      yourTurnLine =
        '<div class="machine-yourturn">' +
          '<span class="machine-yourturn-count">' + m.yourTurnCount + '</span> your turn' +
          (oldestLabel ? ' · oldest ' + escapeHtml(oldestLabel) : '') +
        '</div>';
    }
    return (
      '<a class="machine-card" href="#machine/' + encodeURIComponent(m.host) + '">' +
        '<div class="machine-name">' + escapeHtml(m.host) + '</div>' +
        yourTurnLine +
        '<div class="machine-footer">' +
          '<span class="hb-dot ' + hb.level + '" title="' + escapeHtml(hb.title) + '"></span>' +
          '<span>' + escapeHtml(lastSeenLabel) + '</span>' +
        '</div>' +
      '</a>'
    );
  }

  // ---------- machine view (groups within one host) ----------
  // Same (host, title) → one group card. Click = open the live (latest)
  // stream in the group. Each card shows a "(+N stale)" badge and a
  // small drill-in arrow that goes to the group's full stream list.
  function renderMachineList() {
    const el = document.getElementById('list');
    const countEl = document.getElementById('list-count');
    if (!el) return;
    const inHost = runs.filter((r) => (r.host || 'unknown') === currentMachine);
    const groups = groupByTitle(inHost);
    if (countEl) countEl.textContent = groups.length + (groups.length === 1 ? ' session' : ' sessions');
    if (groups.length === 0) {
      el.innerHTML = '<div class="empty">No streams from this machine.</div>';
      return;
    }
    el.innerHTML = sortGroups(groups).map(groupCard).join('');
    wireDeleteHandlers(el);
  }

  // ---------- group view (drill-down — every stream in a (host, title)) ----------
  function renderGroupList() {
    const el = document.getElementById('list');
    const countEl = document.getElementById('list-count');
    if (!el || !currentGroup) return;
    const inGroup = runs.filter((r) =>
      (r.host || 'unknown') === currentGroup.host &&
      (r.title || '') === (currentGroup.title || ''));
    if (countEl) countEl.textContent = inGroup.length + (inGroup.length === 1 ? ' stream' : ' streams');
    if (inGroup.length === 0) {
      el.innerHTML = '<div class="empty">No streams in this group.</div>';
      return;
    }
    el.innerHTML = sortRuns(inGroup).map(streamCard).join('');
    wireDeleteHandlers(el);
  }

  function renderListError(err) {
    const el = document.getElementById('list');
    if (!el) return;
    el.innerHTML = '<div class="empty">Failed to load: ' + escapeHtml((err && err.message) || String(err)) + '</div>';
  }

  function groupByTitle(runList) {
    const map = new Map();
    for (const r of runList) {
      const key = (r.title || '(untitled)');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const out = [];
    map.forEach((streams, title) => {
      // The "primary" stream of a group is the one with the freshest
      // lastSeenAt — the live tile users want to land on by default.
      const sorted = streams.slice().sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
      const primary = sorted[0];
      out.push({ title, primary, all: sorted, count: streams.length });
    });
    return out;
  }

  // Group sort: attention first (any your_turn within group → top),
  // then within ties use a stable key. lastSeenAt would bump on every
  // heartbeat (~2s) and shuffle order while everyone's "your turn";
  // max startedAt across the group's runs is stable until the set of
  // runs itself changes.
  function sortGroups(groups) {
    const stableKey = (g) => g.all.reduce((m, r) => Math.max(m, r.startedAt || 0), 0);
    return groups.slice().sort((a, b) => {
      const aHas = a.all.some((r) => cardState(r).kind === 'your_turn');
      const bHas = b.all.some((r) => cardState(r).kind === 'your_turn');
      if (aHas !== bHas) return aHas ? -1 : 1;
      const ka = stableKey(a);
      const kb = stableKey(b);
      if (ka !== kb) return kb - ka;
      return (a.title || '').localeCompare(b.title || '');
    });
  }

  function groupCard(g) {
    const r = g.primary;
    const st = cardState(r);
    const hb = heartbeatState(r.lastSeenAt);
    const working = r.isWorking && hb.level === 'live';
    const indicator = (st.kind === 'your_turn')
      ? '<span class="term-cursor" title="awaiting your input"></span>'
      : '<span class="hb-dot ' + hb.level + (working ? ' working' : '') + '" title="' + escapeHtml(hb.title) + '"></span>';
    const stripeStyle = (typeof r.hue === 'number') ? ` style="--card-hue: oklch(65% 0.27 ${r.hue});"` : '';
    const moreBadge = g.count > 1
      ? `<a class="group-drill" href="#group/${encodeURIComponent(r.host || '')}/${encodeURIComponent(r.title || '')}" title="${g.count} streams · click to pick a past one">+${g.count - 1}</a>`
      : '';
    return (
      '<div class="run-card-wrap">' +
        '<a class="run-card ' + st.kind + '" href="#' + encodeURIComponent(r.runId) + '"' + stripeStyle + '>' +
          '<div class="cli">' + escapeHtml(r.cli || '?') + '</div>' +
          '<div class="title">' + escapeHtml(r.title || '(untitled)') + '</div>' +
          '<div class="meta">' +
            indicator +
            '<span>' + escapeHtml(r.lastSeenAt ? fmtAgo(r.lastSeenAt) : 'never') + '</span>' +
          '</div>' +
        '</a>' +
        moreBadge +
      '</div>'
    );
  }

  function streamCard(r) {
    const st = cardState(r);
    const hb = heartbeatState(r.lastSeenAt);
    const working = r.isWorking && hb.level === 'live';
    const indicator = (st.kind === 'your_turn')
      ? '<span class="term-cursor" title="awaiting your input"></span>'
      : '<span class="hb-dot ' + hb.level + (working ? ' working' : '') + '" title="' + escapeHtml(hb.title) + '"></span>';
    const stripeStyle = (typeof r.hue === 'number') ? ` style="--card-hue: oklch(65% 0.27 ${r.hue});"` : '';
    return (
      '<div class="run-card-wrap">' +
        '<a class="run-card ' + st.kind + '" href="#' + encodeURIComponent(r.runId) + '"' + stripeStyle + '>' +
          '<div class="cli">' + escapeHtml(r.cli || '?') + '</div>' +
          '<div class="title">' + escapeHtml('stream ' + r.runId.slice(0, 8) + ' · started ' + (r.startedAt ? fmtAgo(r.startedAt) : '?')) + '</div>' +
          '<div class="meta">' +
            indicator +
            '<span>' + escapeHtml(r.lastSeenAt ? fmtAgo(r.lastSeenAt) : 'never') + '</span>' +
          '</div>' +
        '</a>' +
        '<button class="run-delete" data-runid="' + escapeHtml(r.runId) + '" title="Delete this stream">✕</button>' +
      '</div>'
    );
  }

  function wireDeleteHandlers(container) {
    container.querySelectorAll('.run-delete').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.dataset.runid;
        if (!id) return;
        if (!confirm('Delete this stream? The source can re-register but its current ring contents will be lost.')) return;
        btn.disabled = true;
        try {
          const res = await authFetch('/runs/' + encodeURIComponent(id), { method: 'DELETE' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          runs = runs.filter((r) => r.runId !== id);
          if (view === 'machine') renderMachineList();
          else if (view === 'group') renderGroupList();
        } catch (err) {
          alert('Delete failed: ' + ((err && err.message) || String(err)));
          btn.disabled = false;
        }
      });
    });
  }

  function cardState(r) {
    const hb = heartbeatState(r.lastSeenAt);
    if (hb.level === 'live') {
      if (r.isWorking) return { kind: 'working', title: 'working · ' + hb.title };
      return { kind: 'your_turn', title: 'awaiting your input · ' + hb.title };
    }
    return { kind: hb.level, title: hb.title };
  }

  const CARD_SORT_RANK = { your_turn: 0, working: 1, idle: 2, stale: 3, unknown: 4 };
  function sortRuns(list) {
    return list.slice().sort((a, b) => {
      const ra = CARD_SORT_RANK[cardState(a).kind] ?? 9;
      const rb = CARD_SORT_RANK[cardState(b).kind] ?? 9;
      if (ra !== rb) return ra - rb;
      const sb = b.startedAt || 0;
      const sa = a.startedAt || 0;
      if (sb !== sa) return sb - sa;
      return (a.runId || '').localeCompare(b.runId || '');
    });
  }

  function heartbeatState(lastSeenAt) {
    if (!lastSeenAt) return { level: 'unknown', title: 'never seen' };
    const age = Date.now() - lastSeenAt;
    if (age < HB_LIVE_MS) return { level: 'live', title: 'live · last seen ' + fmtAgo(lastSeenAt) };
    if (age < HB_IDLE_MS) return { level: 'idle', title: 'idle · last seen ' + fmtAgo(lastSeenAt) };
    return { level: 'stale', title: 'stale · last seen ' + fmtAgo(lastSeenAt) };
  }

  // ---------- detail view ----------
  // One continuous buffer per run. Plain rows + STITCH/GAP markers from
  // the stitcher. The viewer mirrors whatever the source's CLI rendered.
  function renderDetailBuffer() {
    const grid = document.getElementById('grid');
    if (!grid) return;
    diffGridToBuffer(grid, trimBlanksAroundMarkers(buffer));
    updateTopbarTitle();
  }

  // Two-pass cleanup before rendering:
  //   Pass 1: drop blank rows immediately before or after a sentinel.
  //           Markers carry their own margin; surrounding blanks just
  //           pile on whitespace without conveying anything.
  //   Pass 2: collapse consecutive markers. After pass 1, two markers
  //           separated only by blanks end up touching — render them
  //           as ONE. If mixed, BREAK wins over STITCH (stronger signal).
  function trimBlanksAroundMarkers(rows) {
    const isBlank = (r) => r && !r.break_ && !r.stitch && (r.text || '').trim() === '';
    const isMarker = (r) => r && (r.break_ || r.stitch);
    const pass1 = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (isBlank(r)) {
        const prev = pass1[pass1.length - 1];
        const next = i + 1 < rows.length ? rows[i + 1] : null;
        if (isMarker(prev) || isMarker(next)) continue;
      }
      pass1.push(r);
    }
    const out = [];
    for (const r of pass1) {
      const last = out[out.length - 1];
      if (isMarker(r) && isMarker(last)) {
        // Mixed run with a BREAK in it → keep the BREAK.
        if (r.break_ && !last.break_) out[out.length - 1] = r;
        continue;
      }
      out.push(r);
    }
    return out;
  }

  function renderDetailGone() {
    const grid = document.getElementById('grid');
    if (grid) grid.innerHTML = '<div class="empty">Stream ended or expired.</div>';
    const pill = document.getElementById('status-pill');
    if (pill) { pill.textContent = 'gone'; pill.className = 'pill gone'; }
  }

  function diffGridToBuffer(grid, rows) {
    const len = Math.max(grid.children.length, rows.length);
    for (let i = 0; i < len; i++) {
      const desired = rows[i];
      const existing = grid.children[i];
      if (!desired) {
        if (existing) grid.removeChild(existing);
        continue;
      }
      const want = bufferEntryType(desired);
      const have = existing ? bufferNodeType(existing) : null;
      if (want === 'break' || want === 'stitch') {
        if (have === want) continue;
        const node = renderMarker(want);
        if (existing) grid.replaceChild(node, existing); else grid.appendChild(node);
      } else {
        if (have === 'row' && rowEqualToElement(desired, existing)) continue;
        const node = renderRow(desired);
        if (existing) grid.replaceChild(node, existing); else grid.appendChild(node);
      }
    }
    while (grid.children.length > rows.length) grid.removeChild(grid.lastChild);
  }

  function bufferEntryType(entry) {
    if (!entry) return 'row';
    if (entry.break_) return 'break';
    if (entry.stitch) return 'stitch';
    return 'row';
  }
  function bufferNodeType(el) {
    if (!el || !el.classList) return null;
    if (el.classList.contains('mk-break')) return 'break';
    if (el.classList.contains('mk-stitch')) return 'stitch';
    return 'row';
  }

  // Sentinels render as low-visual-weight hairlines; hover-tooltip carries
  // the label. STITCH = frequent normal boundary, kept nearly invisible.
  // BREAK = rare discontinuity — content above and below are disjoint
  // (alt-screen flip, big jump). NOT "data was lost" — both halves are
  // there, they just don't logically continue from one another.
  const MARKER_TITLES = {
    break:  'break in continuity (content above and below are disjoint, e.g. alt-screen flip)',
    stitch: 'stitched (snapshot boundary)',
  };
  function renderMarker(kind) {
    const div = document.createElement('div');
    div.className = 'stream-marker mk-' + kind;
    div.title = MARKER_TITLES[kind] || '';
    return div;
  }

  function rowEqualToElement(row, el) {
    const text = (row && row.text) || '';
    return el && el.textContent === (text.length === 0 ? ' ' : text);
  }

  function renderRow(row) {
    const div = document.createElement('div');
    div.className = 'grid-row';
    const text = (row && row.text) || '';
    if (text.length === 0) { div.className = 'grid-row empty'; div.textContent = ' '; return div; }
    const styles = (row && row.styles) || [];
    if (styles.length === 0) { div.textContent = text; return div; }
    styles.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (let i = 0; i < styles.length; i++) {
      const s = styles[i];
      if (s.start > cursor) div.appendChild(plainSpan(text.substring(cursor, s.start)));
      const end = Math.min(s.end, text.length);
      if (end > s.start) {
        const span = document.createElement('span');
        span.textContent = text.substring(s.start, end);
        applyStyle(span, s);
        div.appendChild(span);
        cursor = end;
      }
    }
    if (cursor < text.length) div.appendChild(plainSpan(text.substring(cursor)));
    return div;
  }

  function plainSpan(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  function applyStyle(span, s) {
    let fg = resolveColor(s.fg);
    let bg = resolveColor(s.bg);
    if (s.inverse) { const swap = fg; fg = bg || '#0c0c0c'; bg = swap || '#cccccc'; }
    if (fg) span.style.color = fg;
    if (bg) span.style.background = bg;
    const classes = [];
    if (s.bold) classes.push('b');
    if (s.italic) classes.push('i');
    if (s.dim) classes.push('dm');
    if (s.underline && s.strike) classes.push('us');
    else if (s.underline) classes.push('u');
    else if (s.strike) classes.push('s');
    if (classes.length) span.className = classes.join(' ');
  }

  function updateTopbarTitle() {
    const titleEl = document.getElementById('run-title');
    if (!titleEl) return;
    const meta = runs.find((r) => r.runId === currentRunId);
    titleEl.textContent = (meta && meta.title) || currentRunId;
  }

  function updateTopbarPill() {
    const pill = document.getElementById('status-pill');
    if (!pill) return;
    const st = cardState({ lastSeenAt: currentLastSeenAt, isWorking: currentIsWorking });
    const labelMap = { working: 'working', your_turn: 'your turn', idle: 'idle', stale: 'stale', unknown: '—' };
    pill.textContent = labelMap[st.kind];
    pill.className = 'pill hb-pill ' + st.kind;
    pill.title = st.title;
  }

  // ---------- color resolution ----------
  const PALETTE_16 = [
    '#0c0c0c', '#c50f1f', '#13a10e', '#c19c00',
    '#0037da', '#881798', '#3a96dd', '#cccccc',
    '#767676', '#e74856', '#16c60c', '#f9f1a5',
    '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
  ];
  function resolveColor(s) {
    if (!s) return null;
    if (s.charCodeAt(0) === 35) return s;
    if (s.charCodeAt(0) === 112) {
      const n = parseInt(s.substring(1), 10);
      if (isNaN(n)) return null;
      if (n < 16) return PALETTE_16[n];
      return xterm256(n);
    }
    return null;
  }
  function xterm256(n) {
    if (n >= 16 && n <= 231) {
      const idx = n - 16;
      const r = Math.floor(idx / 36);
      const g = Math.floor((idx % 36) / 6);
      const b = idx % 6;
      const v = (x) => x === 0 ? 0 : x * 40 + 55;
      return rgbToHex(v(r), v(g), v(b));
    }
    if (n >= 232 && n <= 255) { const v = 8 + (n - 232) * 10; return rgbToHex(v, v, v); }
    return null;
  }
  function rgbToHex(r, g, b) {
    const h = (x) => ('00' + x.toString(16)).slice(-2);
    return '#' + h(r) + h(g) + h(b);
  }

  // ---------- misc ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtAgo(ts) {
    if (!ts) return '';
    const ago = Math.round((Date.now() - ts) / 1000);
    if (ago < 60) return ago + 's ago';
    if (ago < 3600) return Math.round(ago / 60) + 'm ago';
    if (ago < 86400) return Math.round(ago / 3600) + 'h ago';
    return Math.round(ago / 86400) + 'd ago';
  }
})();
