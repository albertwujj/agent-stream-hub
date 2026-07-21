// Stitcher tests.
//
// The stitcher merges a stream of source-viewport SNAPSHOTS into a single
// logical buffer, using top-of-snapshot row alignment to detect:
//   · append-style scroll (Claude): new content appended, STITCH marker.
//   · in-place update: same top rows, replaced, no marker.
//   · alt-screen flip or big jump: alignment fails → preserve buf, BREAK
//     marker, append snapshot. Content above/below the BREAK is disjoint
//     (different views) but both fully captured — not a "data loss" signal.
//
// Latest snapshot's version of any overlapping row wins.

const { stitch, BREAK, STITCH } = require('../public/stitcher');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); failed++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'eq'}\n  got:  ${a}\n  want: ${e}`);
}

// Helpers — make a row from text only (no styles).
const r = (t) => ({ text: t });
const rows = (...ts) => ts.map(r);

// =========== empty / trivial cases ===========

test('empty buffer + first snapshot → buffer = snapshot', () => {
  const out = stitch([], rows('a', 'b', 'c'));
  eq(out, rows('a', 'b', 'c'));
});

test('non-empty buffer + empty snapshot → unchanged', () => {
  const buf = rows('a', 'b', 'c');
  const out = stitch(buf, []);
  eq(out, buf);
});

test('empty buffer + empty snapshot → empty', () => {
  eq(stitch([], []), []);
});

// =========== append-style scroll (Claude pattern) ===========

test('append: one new row at bottom (STITCH at boundary)', () => {
  const buf = rows('a', 'b', 'c', 'd', 'e');
  const snap = rows('b', 'c', 'd', 'e', 'f');
  // Align at offset 1 → buf[0..0] + STITCH + snap.
  const out = stitch(buf, snap);
  eq(out, [r('a'), STITCH, ...rows('b', 'c', 'd', 'e', 'f')]);
});

test('append: multiple new rows (STITCH at boundary)', () => {
  const buf = rows('a', 'b', 'c', 'd', 'e');
  const snap = rows('c', 'd', 'e', 'f', 'g', 'h');
  // Align at offset 2 → buf[0..1] + STITCH + snap.
  const out = stitch(buf, snap);
  eq(out, [r('a'), r('b'), STITCH, ...rows('c', 'd', 'e', 'f', 'g', 'h')]);
});

test('alignment failure: preserve buf + BREAK + snap (always-preserve model)', () => {
  // No alignment found, sizes similar. Under the always-preserve model
  // we keep the buffer + insert a BREAK marker + append the snapshot.
  // Scroll-back stays available across discontinuities.
  const buf = rows('a', 'b', 'c', 'd', 'e');
  const snap = rows('x', 'y', 'z', 'w', 'v');
  const out = stitch(buf, snap);
  eq(out, [...buf, BREAK, ...snap]);
});

test('alignment failure (tiny snap, big buf): preserve + BREAK + snap', () => {
  const buf = rows('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
  const snap = rows('x', 'y');
  const out = stitch(buf, snap);
  eq(out, [...buf, BREAK, ...snap]);
});

test('append: rebuilt to same length over time (one STITCH per step)', () => {
  let buf = rows('a', 'b', 'c', 'd', 'e');
  buf = stitch(buf, rows('b', 'c', 'd', 'e', 'f'));
  buf = stitch(buf, rows('c', 'd', 'e', 'f', 'g'));
  buf = stitch(buf, rows('d', 'e', 'f', 'g', 'h'));
  // Each step appends one row + one STITCH marker at the boundary. The
  // markers accumulate as the buffer evolves (intentional — each is a
  // separate alignment event; viewer renders them as hairlines).
  eq(buf, [
    r('a'), STITCH, r('b'), STITCH, r('c'), STITCH,
    r('d'), r('e'), r('f'), r('g'), r('h'),
  ]);
});

// =========== in-place update (alt-screen TUI) ===========

test('in-place: top 3 unchanged, bottom row changed → alignment at offset 0 replaces tail', () => {
  const buf = rows('chrome1', 'chrome2', 'chrome3', 'old body');
  const snap = rows('chrome1', 'chrome2', 'chrome3', 'new body');
  // Top-3 of snap = [chrome1, chrome2, chrome3]. Match at buf offset 0.
  // Replace from offset 0: buf[0..-1] (empty) + snap = snap.
  const out = stitch(buf, snap);
  eq(out, snap);
});

test('in-place: full-viewport repaint of alt-screen → buffer = latest snapshot', () => {
  // Alt-screen pattern: top chrome rows stay identical, body content rotates.
  // K-iteration falls back from K=3 to K=2 once the body row mismatch is hit;
  // K=2 then aligns on the two chrome rows at offset 0 and replaces the tail.
  let buf = rows('logo', 'status', 'input box', '(empty)');
  buf = stitch(buf, rows('logo', 'status', 'reply line 1', '> '));
  eq(buf, rows('logo', 'status', 'reply line 1', '> '));
  buf = stitch(buf, rows('logo', 'status', 'reply line 1+', '> '));
  eq(buf, rows('logo', 'status', 'reply line 1+', '> '));
});

// =========== clear / reset ===========

test('clear: same-size snapshot with no overlap → preserve + BREAK + snap', () => {
  const buf = rows('a', 'b', 'c');
  const snap = rows('new banner', 'new chrome', 'new body');
  const out = stitch(buf, snap);
  eq(out, [...buf, BREAK, ...snap]);
});

test('after BREAK + extension: align cleanly post-break', () => {
  let buf = rows('a', 'b', 'c');
  buf = stitch(buf, rows('x', 'y', 'z'));
  eq(buf, [...rows('a', 'b', 'c'), BREAK, ...rows('x', 'y', 'z')]);
  // Step 2: extension aligns at y in the post-break section → STITCH at boundary.
  buf = stitch(buf, rows('y', 'z', 'w'));
  eq(buf, [...rows('a', 'b', 'c'), BREAK, r('x'), STITCH, ...rows('y', 'z', 'w')]);
});

test('alignment never anchors on a sentinel', () => {
  // Buffer has a sentinel between two halves. Snapshot rows match the
  // first half — alignment must use those, not the sentinel.
  let buf = [r('a'), r('b'), r('c'), BREAK, r('a'), r('b'), r('d')];
  buf = stitch(buf, rows('a', 'b', 'c'));
  // Alignment at offset 0 (first half) — offset = 0 means full replace,
  // no STITCH marker. Buffer becomes just snap.
  eq(buf, rows('a', 'b', 'c'));
});

// =========== latest-snapshot wins for overlapping rows ===========

test('overlap row content updated by latest snapshot', () => {
  const buf = [
    { text: 'a', styles: [{ start: 0, end: 1, bold: true }] },
    r('b'),
    r('c'),
  ];
  // Snapshot has same text rows but no styles.
  const snap = rows('a', 'b', 'c');
  const out = stitch(buf, snap);
  // Latest version wins: styles dropped because snapshot rows don't carry them.
  eq(out, snap);
});

// =========== MAX_ROWS cap ===========

test('cap: buffer trimmed from top when exceeding MAX_ROWS', () => {
  const buf = rows('a', 'b', 'c', 'd', 'e');
  const snap = rows('d', 'e', 'f', 'g');
  const out = stitch(buf, snap, { maxRows: 5 });
  // After stitching with STITCH marker: [a, b, c, STITCH, d, e, f, g] → cap 5.
  eq(out, [STITCH, r('d'), r('e'), r('f'), r('g')]);
});

test('cap: large initial snapshot truncated', () => {
  const snap = rows('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
  const out = stitch([], snap, { maxRows: 5 });
  eq(out, rows('f', 'g', 'h', 'i', 'j'));
});

// =========== alignment when top rows are non-substantive ===========

test('alignment skips over mid-snapshot dividers without false-anchoring', () => {
  const buf = rows('header', 'msg 1', '───', 'msg 2');
  const snap = rows('msg 1', '───', 'msg 2', 'msg 3');
  // Substantive rows align at offset 1 → buf[0] + STITCH + snap.
  const out = stitch(buf, snap);
  eq(out, [r('header'), STITCH, r('msg 1'), r('───'), r('msg 2'), r('msg 3')]);
});

test('alignment fails cleanly when buffer top is all non-substantive', () => {
  const buf = [r(''), r('   '), r('───')];
  const snap = rows('content1', 'content2');
  // No substantive overlap → preserve + BREAK + append.
  const out = stitch(buf, snap);
  eq(out, [...buf, BREAK, ...snap]);
});

// =========== spinner-chrome animation (alt-screen with changing top) ===========

test('spinner: changing top glyph aligns via subsequent rows (no marker)', () => {
  // Frame 1: spinner glyph "⠋ Loading"
  let buf = stitch([], [r('⠋ Loading'), r('agent-term'), r('input>')]);
  // Frame 2: spinner advanced to ⠙. Top row differs; subsequent rows DO match
  // (agent-term, input>), so findBestAlignment anchors on the matching pair
  // and aligns cleanly at offset 0 — no marker needed for the common case.
  buf = stitch(buf, [r('⠙ Loading'), r('agent-term'), r('input>')]);
  eq(buf, [r('⠙ Loading'), r('agent-term'), r('input>')]);
});

// =========== sentinel shapes ===========

test('BREAK and STITCH are recognizable sentinels', () => {
  eq(BREAK.break_, true);
  eq(STITCH.stitch, true);
});

// =========== edge: snapshot shorter than alignment window ===========

test('short snapshot (2 rows): aligns at offset 3 with STITCH', () => {
  const buf = rows('a', 'b', 'c', 'd', 'e');
  const snap = rows('d', 'e');
  const out = stitch(buf, snap);
  eq(out, [r('a'), r('b'), r('c'), STITCH, r('d'), r('e')]);
});

test('1-row snapshot: aligns if that row appears in buf, else gap + append', () => {
  const buf = rows('a', 'b', 'c');
  eq(stitch(buf, [r('b')]), [r('a'), STITCH, r('b')]);  // align at offset 1
  eq(stitch(buf, [r('x')]), [...buf, BREAK, r('x')]);      // no align → preserve + BREAK
});

// =========== prefer LATEST match on repetition ===========

test('codex turn-template: K must reach past the repeating shell to the unique commit hash', () => {
  // Codex shows N conversation turns in one viewport. Each turn ends with
  // the same template:
  //     Done. Rebuilt …
  //       AgentTerm-0.1.12-setup.exe
  //       Release: …
  //       v0.1.12 now points to <COMMIT>
  // Only the commit hash distinguishes one turn from another. With K too
  // small (e.g. 3), the alignment window stops at "Release" — and matches
  // BOTH turns' templates, picking the later one by latest-wins. That
  // causes the next snapshot to be misaligned, leaving the first turn's
  // content duplicated above. K must be large enough to reach the hash.
  const turn = (hash) => [
    r('Done. Rebuilt'),
    r('AgentTerm-0.1.12-setup.exe'),
    r('Release: github.com/.../v0.1.12'),
    r('v0.1.12 now points to ' + hash),
  ];
  const snap8 = [...turn('51201e8'), r('› new commits'), ...turn('384d9ef'), r('› Run /review')];
  const snap9 = [...turn('51201e8'), r('› new commits'), ...turn('384d9ef'), r('› Run /review')];
  // Two snapshots, same content. Stitcher MUST align snap9 at offset 0 →
  // buffer stays the same. The bug would align snap9 at the OFFSET of
  // the SECOND `Done. Rebuilt`, replacing only the tail and leaving
  // turn-1 content duplicated above.
  let buf = stitch([], snap8);
  buf = stitch(buf, snap9);
  eq(buf.length, snap9.length, 'buffer should be exactly snap9, not snap8+tail-of-snap9');
  // Confirm "Done. Rebuilt" appears exactly twice (the two turns),
  // not three times (which is the bug fingerprint).
  const doneCount = buf.filter((row) => row && row.text === 'Done. Rebuilt').length;
  eq(doneCount, 2, '"Done. Rebuilt" should appear exactly 2× (two turns), not 3× (= dup)');
});

test('latest match on repetition wins (handles append over chrome with repeating dividers)', () => {
  const buf = [r('header'), r('───'), r('msg 1'), r('───'), r('msg 2')];
  const snap = [r('───'), r('msg 2'), r('msg 3')];
  // Aligns at offset 3 (latest position of the chrome divider).
  const out = stitch(buf, snap);
  eq(out, [r('header'), r('───'), r('msg 1'), STITCH, r('───'), r('msg 2'), r('msg 3')]);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed ? 1 : 0);
