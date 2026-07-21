// Snapshot stitcher.
//
// Merges a stream of source-viewport snapshots into a single logical buffer
// per block, using top-of-snapshot row alignment to decide what to do:
//
//   · Snapshot's top K substantive rows match a window in the logical
//     buffer at some offset → "replace from that offset with snapshot".
//     This handles both append-style scroll (alignment at offset > 0)
//     and in-place updates (alignment at offset 0).
//
//   · No match → insert a GAP marker and append snapshot as a new section.
//     This is the honest "we lost some content here" UI signal.
//
// Latest snapshot's version of any overlapping row wins, which is the
// correct behavior for spinner cells, status lines, and live updates.
//
// Substantive-row filter (skip whitespace + box-drawing-only rows) keeps
// false alignments off of chrome dividers.
//
// Module loads in two contexts:
//   · Node tests via `require('../public/stitcher')`.
//   · Browser via `<script>` then `window.Stitcher`.

(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.Stitcher = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Sentinels — buffer entries that aren't rows. The viewer renders each
  // as a thin divider; hover shows a short label.
  //
  //   STITCH — alignment succeeded at offset > 0. Snapshots flow into each
  //            other across this boundary; this marker is informational
  //            ("two snapshots joined here"). Normal operation, frequent.
  //   BREAK  — alignment failed. Old buffer preserved, snapshot appended
  //            after the marker. The content above and below are LOGICALLY
  //            DISJOINT (different views, different terminal modes) but
  //            both fully captured. Not the same as "data was lost" — the
  //            two halves just don't continue from one another. Common
  //            triggers: alt-screen flip (enter/exit picker/modal), big
  //            terminal redraw, viewport resize.
  const STITCH = Object.freeze({ stitch: true });
  const BREAK = Object.freeze({ break_: true });

  // True for buffer entries that are sentinels rather than rows. Alignment
  // treats them as non-substantive — can't match against, can't score.
  function isSentinel(entry) {
    return !!(entry && (entry.break_ || entry.stitch));
  }

  const DEFAULT_MAX_ROWS = 1000;    // cap on logical buffer size

  // A row is "substantive" if it has text that isn't all whitespace and
  // isn't all box-drawing / divider glyphs. Stops alignment from latching
  // onto chrome borders.
  const TRIVIAL_RE = /^[\s─-╿\-=_~·•]*$/;
  function isSubstantive(row) {
    if (!row || isSentinel(row)) return false;
    const t = (row.text || '');
    return t.length > 0 && !TRIVIAL_RE.test(t);
  }

  // Text-only equality. Styles often differ across snapshots even for the
  // same logical content (cursor, transient highlights), so we don't use
  // them for alignment. Latest snapshot's styles still apply on replace.
  function rowsMatch(a, b) {
    if (!a || !b) return false;
    if (isSentinel(a) || isSentinel(b)) return false;
    return (a.text || '') === (b.text || '');
  }

  // Pick up to K substantive rows from the front of `snapshot`. Returns
  // an array of { row, idx } pairs — idx is the row's position within
  // the snapshot, which we need to convert an alignment match into the
  // correct buffer offset.
  function collectAlignmentWindow(snapshot, K) {
    const out = [];
    for (let i = 0; i < snapshot.length && out.length < K; i++) {
      if (isSubstantive(snapshot[i])) {
        out.push({ row: snapshot[i], idx: i });
      }
    }
    return out;
  }

  // Search the logical buffer for the LATEST offset `o` such that, for
  // every (row, idx) in the alignment window, buffer[o + idx] === row
  // (by text). Returns the offset, or -1 if no match.
  //
  // "Latest" wins on repetition (chrome dividers repeated through buffer)
  // because the typical pattern is content scrolling — newer matches
  // reflect less scroll since last snapshot.
  function findLatestMatch(buffer, window) {
    if (window.length === 0) return -1;
    const lastIdx = window[window.length - 1].idx;
    // Highest possible offset: buffer.length - lastIdx - 1 (so buffer[o + lastIdx] still exists).
    const maxOffset = buffer.length - lastIdx - 1;
    for (let o = maxOffset; o >= 0; o--) {
      let ok = true;
      for (const { row, idx } of window) {
        if (!rowsMatch(buffer[o + idx], row)) { ok = false; break; }
      }
      if (ok) return o;
    }
    return -1;
  }

  // Find the buffer offset where snapshot aligns best with buffer.
  //
  // Algorithm: try every substantive row of snapshot as an anchor. For each
  // anchor's matching positions in buffer, compute a SCORE = how many of
  // snapshot's substantive rows match buffer at the corresponding offsets.
  // Pick the offset with the highest score (tie → highest offset = latest,
  // matching chrome-divider semantics and the "aggressive truncation"
  // preference for tied content).
  //
  // Why anchor on every row, not just subs[0]: when the first row changes
  // between snapshots (spinner glyph, cursor position, header timestamp),
  // subs[0]-only anchoring finds no match even though subs[1..] line up
  // perfectly. Trying every anchor catches those.
  //
  // Why score over the whole snap rather than a fixed-K window: repeating
  // templates (e.g. codex's per-turn `Done.Rebuilt / AgentTerm / Release`)
  // match a small window at multiple offsets. The correct one extends
  // further. Scoring picks the correct offset regardless of template length.
  //
  // Returns -1 if no offset achieves a score ≥ 2 (or ≥ 1 when snap has
  // only one substantive row). Falls back to alt-screen-replace / GAP.
  function findBestAlignment(buffer, subs) {
    if (subs.length === 0 || buffer.length === 0) return -1;
    let bestOffset = -1;
    let bestScore = 0;
    let bestFits = 0;
    // Different anchors can land on the same offset; no need to re-score.
    const seenOffsets = new Set();
    for (let anchorI = 0; anchorI < subs.length; anchorI++) {
      const anchor = subs[anchorI];
      // Walk buf from the back so ties (same score) keep the highest offset.
      for (let bi = buffer.length - 1; bi >= 0; bi--) {
        if (!rowsMatch(buffer[bi], anchor.row)) continue;
        const o = bi - anchor.idx;
        if (o < 0) continue;
        if (seenOffsets.has(o)) continue;
        seenOffsets.add(o);
        // For this offset, count subs that FIT in buf (target in range)
        // and how many of those MATCH.
        let score = 0, fits = 0;
        for (const { row, idx } of subs) {
          const target = o + idx;
          if (target < 0 || target >= buffer.length) continue;
          fits++;
          if (rowsMatch(buffer[target], row)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestFits = fits;
          bestOffset = o;
        }
      }
    }
    // Accept the offset if its match is strong enough:
    //   · score ≥ 2: at least 2 substantive rows align — robust.
    //   · OR score == fits ≥ 1: snap is short or sits near buffer's end
    //     so only `fits` rows could possibly match, and they all did.
    //     This is a perfect alignment given the constraints.
    // Otherwise (weak 1-row coincidence among many possible subs) → -1.
    if (bestScore >= 2 || (bestScore >= 1 && bestScore === bestFits)) {
      return bestOffset;
    }
    return -1;
  }

  function cap(buf, maxRows) {
    if (buf.length <= maxRows) return buf;
    return buf.slice(buf.length - maxRows);
  }

  // The exported entry point. Returns the new logical buffer after merging
  // `snapshot` into `buffer`.
  //
  // Algorithm:
  //   1. Collect every substantive row of `snapshot`.
  //   2. Find the buffer offset whose extended match against snapshot's
  //      substantive rows is LONGEST — that's the correct alignment by
  //      construction (any other offset diverges sooner).
  //   3. If no offset gives a 2+-row match (or there's only one candidate
  //      with a 1-row match), accept the 1-row match.
  //   4. If no match at all, fall through to alt-screen-replace heuristic
  //      (size-similar → REPLACE) or GAP + append.
  function stitch(buffer, snapshot, opts) {
    opts = opts || {};
    const maxRows = opts.maxRows || DEFAULT_MAX_ROWS;

    if (!snapshot || snapshot.length === 0) return buffer.slice();
    if (!buffer || buffer.length === 0) return cap(snapshot.slice(), maxRows);

    // Substantive rows of snapshot, in order. Alignment uses these to skip
    // whitespace/chrome rows that would otherwise produce false matches.
    const subs = [];
    for (let i = 0; i < snapshot.length; i++) {
      if (isSubstantive(snapshot[i])) subs.push({ row: snapshot[i], idx: i });
    }
    // No substantive rows at all → fall back to the snapshot's top row.
    if (subs.length === 0 && snapshot.length > 0) {
      subs.push({ row: snapshot[0], idx: 0 });
    }

    const offset = findBestAlignment(buffer, subs);

    let next;
    if (offset > 0) {
      // Aligned mid-buffer: keep rows above the boundary, append a STITCH
      // sentinel + the snapshot.
      next = buffer.slice(0, offset).concat([STITCH], snapshot);
    } else if (offset === 0) {
      // Aligned at the start: full in-place update, no boundary marker.
      next = snapshot.slice();
    } else {
      // No alignment found. Preserve the buffer + a BREAK sentinel + the
      // snapshot. Note this is NOT "we lost content" — both halves were
      // captured intact; they just don't continue from one another. Lets
      // the user scroll back through prior content even across alt-screen
      // flips and big jumps. Buffer is capped by maxRows, so accumulation
      // is bounded.
      next = buffer.concat([BREAK], snapshot);
    }

    return cap(next, maxRows);
  }

  return { stitch, BREAK, STITCH, isSubstantive, rowsMatch, findLatestMatch, findBestAlignment, collectAlignmentWindow };
}));
