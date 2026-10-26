/* plugin-motr.js — Mouse Tracking for Reading (MoTR) for jsPsych 8, with word-locked and one-way windows.

   Based on the plugin of the suppression study (Lin, October 2026), which reimplements the display of Wilcox, Ding,
   Sachan, & Jäger (2024, JML 138, 104534; https://github.com/wilcoxeg/MoTR). Two options were added for the
   transposed-word study (Experiment 2):

   reveal = "ellipse"  the original MoTR display: a sharp oval window (focus_w x focus_h px) follows the cursor.
   reveal = "words"    a word-locked window: the word under the centre of the window is sharp, together with
                       span_left words before it and span_right words after it; every other word stays blurred.
                       span_left = span_right = 0 gives a one-word window, 1 and 1 a three-word window.
                       The window is defined by word boundaries, not pixels, so a "one-word" window never shows
                       two short words at once (a 102-px oval can).
   oneway = true       the reader cannot go back. The frontier is the rightmost word the centre has reached since it
                       first reached Word 1 (no word is sharp before that). Moving the centre onto any word before the
                       frontier shows nothing, and those samples are counted (blocked_samples). While the centre is on
                       the frontier, the words of the window around it are shown as usual, but no word before
                       frontier - span_left is ever shown again. oneway works with reveal = "words" only.
   mask = "bar"        ("words" mode) the words that are not sharp are replaced by one light grey bar per line, so their
                       lengths and positions cannot be seen; mask = "blur" keeps the blurred text of the original MoTR.
                       The bar removes a cue that the blur leaves: in the TW items the short function word is always
                       Word 3 and in the counterparts Word 4, which blurred word lengths would reveal before reading.

   Display: the passage is drawn twice. The bottom layer is blurred. The top layer is sharp; in "ellipse" mode it is
   clipped to an oval around the cursor, in "words" mode each sharp word is shown or hidden individually.

   Recorded per trial:
     motr_samples  JSON [[t_ms, x, y], ...] cursor positions relative to the text box
     word_boxes    JSON [[index, word, left, top, right, bottom], ...] in the same frame
     vis_log       JSON [[t_ms, first, last], ...] every change of the sharp words ("words" mode; -1 -1 = none sharp)
     max_word, blocked_samples, reached_last_word, reading_time, and the fields of the earlier version
   How reading ends (end_mode):
     "button"  the reader clicks Done below the sentence (the original MoTR procedure)
     "exit"    reading ends when the centre of the window moves past the right edge of the last word (by exit_px),
               after the window has been on the first and then on the last word
     "key"     the reader presses the space bar
   Word-level measures (first pass, go-past, total, regressions) are computed offline by
   1_project/analysis/motr_preprocess.R, so the raw stream is never lost.
   AI assistance: the extensions were drafted with Claude (Anthropic) under our direction and then reviewed, run and
   checked by us (see the project README). */
var jsPsychMotr = (function (jspsych) {
  "use strict";
  const info = {
    name: "motr",
    version: "2.0.1",
    parameters: {
      text:         { type: jspsych.ParameterType.STRING, default: undefined },
      /* Defaults follow the Provo experiment of Wilcox et al. (2024): font-size 18px, line-height 40px, blurry layer
         filter: blur(3.5px), sharp window an oval 102 x 38 px whose centre sits 12 px right of and 6 px above the
         cursor tip. experiment.html overrides the text size and blur (see its CONFIG.MOTR). */
      font_size:    { type: jspsych.ParameterType.INT, default: 18 },
      line_height:  { type: jspsych.ParameterType.FLOAT, default: 40 / 18 },
      text_width:   { type: jspsych.ParameterType.INT, default: 820 },
      blur_px:      { type: jspsych.ParameterType.FLOAT, default: 3.5 },
      blur_opacity: { type: jspsych.ParameterType.FLOAT, default: 0.3 },  // MoTR shows the blurred layer at opacity .3
      focus_shape:  { type: jspsych.ParameterType.STRING, default: "ellipse" },  // "ellipse" (MoTR) or "rect" (reveal = "ellipse")
      focus_w:      { type: jspsych.ParameterType.INT, default: 102 },
      focus_h:      { type: jspsych.ParameterType.INT, default: 38 },
      focus_dx:     { type: jspsych.ParameterType.INT, default: 12 },   // window centre relative to cursor tip
      focus_dy:     { type: jspsych.ParameterType.INT, default: -6 },
      reveal:       { type: jspsych.ParameterType.STRING, default: "ellipse" },  // "ellipse" or "words"
      span_left:    { type: jspsych.ParameterType.INT, default: 0 },    // "words": sharp words before the centre word
      span_right:   { type: jspsych.ParameterType.INT, default: 0 },    // "words": sharp words after the centre word
      oneway:       { type: jspsych.ParameterType.BOOL, default: false },
      line_tol:     { type: jspsych.ParameterType.INT, default: 14 },   // "words": px above/below the line that still count as on it
      mask:         { type: jspsych.ParameterType.STRING, default: "blur" }, // "words": "blur" (MoTR) or "bar" (no word lengths shown)
      min_sample_ms: { type: jspsych.ParameterType.FLOAT, default: 4 },  // at most one sample every 4 ms (250 Hz)
      min_reading:  { type: jspsych.ParameterType.INT, default: 300 },  // ms before reading can end
      done_label:   { type: jspsych.ParameterType.STRING, default: "Done" },
      end_mode:     { type: jspsych.ParameterType.STRING, default: "button" },
      exit_px:      { type: jspsych.ParameterType.INT, default: 12 },
      end_hint:     { type: jspsych.ParameterType.STRING, default: null }
    },
    data: {
      motr_samples: { type: jspsych.ParameterType.STRING },
      word_boxes:   { type: jspsych.ParameterType.STRING },
      vis_log:      { type: jspsych.ParameterType.STRING },
      reading_time: { type: jspsych.ParameterType.INT },
      n_samples:    { type: jspsych.ParameterType.INT },
      reached_last_word: { type: jspsych.ParameterType.BOOL },
      max_word:     { type: jspsych.ParameterType.INT },
      blocked_samples: { type: jspsych.ParameterType.INT },
      premature_clicks: { type: jspsych.ParameterType.INT },
      last_word_to_done: { type: jspsych.ParameterType.FLOAT },
      done_click_time: { type: jspsych.ParameterType.FLOAT },
      end_mode: { type: jspsych.ParameterType.STRING },
      reveal: { type: jspsych.ParameterType.STRING },
      span_left: { type: jspsych.ParameterType.INT },
      span_right: { type: jspsych.ParameterType.INT },
      oneway: { type: jspsych.ParameterType.BOOL },
      mask: { type: jspsych.ParameterType.STRING },
      focus_dx: { type: jspsych.ParameterType.INT }, focus_dy: { type: jspsych.ParameterType.INT }, line_tol: { type: jspsych.ParameterType.INT },
      words_seen: { type: jspsych.ParameterType.INT },      // number of different words that were under the window centre and sharp
      keys_during_reading: { type: jspsych.ParameterType.INT }
    }
  };

  class MotrPlugin {
    constructor(jsPsych) { this.jsPsych = jsPsych; }
    trial(el, trial) {
      // A mistyped option must never leave the reader stuck, so unknown values fall back to the original procedure.
      if (!["button", "exit", "key"].includes(trial.end_mode)) {
        console.warn("plugin-motr: unknown end_mode '" + trial.end_mode + "', using 'button'"); trial.end_mode = "button"; }
      if (!["ellipse", "words"].includes(trial.reveal)) {
        console.warn("plugin-motr: unknown reveal '" + trial.reveal + "', using 'ellipse'"); trial.reveal = "ellipse"; }
      const WORDS = trial.reveal === "words";
      const ONEWAY = WORDS && !!trial.oneway;
      const SL = Math.max(0, trial.span_left | 0), SR = Math.max(0, trial.span_right | 0);
      const BAR = WORDS && trial.mask === "bar";

      const words = trial.text.trim().split(/\s+/);
      const spans = words.map((w, i) => '<span class="motr-w" data-i="' + i + '">' + esc(w) + '</span>').join(" ");
      const box = 'font-size:' + trial.font_size + 'px;line-height:' + trial.line_height + ';width:' + trial.text_width + 'px;';
      el.innerHTML =
        '<div id="motr-wrap" style="position:relative;margin:0 auto;' + box + 'text-align:left;cursor:crosshair;' +
        'font-family:Georgia,\'Times New Roman\',serif;user-select:none;-webkit-user-select:none">' +
          '<style>#motr-wrap,#motr-wrap div,#motr-wrap span{font-family:Georgia,"Times New Roman",serif!important}</style>' +
          '<div id="motr-blur" style="filter:blur(' + trial.blur_px + 'px);opacity:' + trial.blur_opacity + ';color:#000">' + spans + '</div>' +
          '<div id="motr-sharp" aria-hidden="true" style="position:absolute;inset:0;color:#000;' +
            (WORDS ? '' : 'clip-path:ellipse(0px 0px at -100px -100px)') + '">' + spans + '</div>' +
        '</div>' +
        '<div style="width:' + trial.text_width + 'px;margin:34px auto 0;text-align:center">' +
          (trial.end_mode === "button" ? '<button class="jspsych-btn" id="motr-done">' + trial.done_label + '</button>'
            : '<p id="motr-endhint" style="color:#888;font-size:15px">' + (trial.end_hint || (trial.end_mode === "key"
                ? "Press the SPACE bar when you have read the sentence." : "Move past the last word to continue.")) + '</p>') + '</div>';
      const wrap = el.querySelector("#motr-wrap");
      const sharp = el.querySelector("#motr-sharp");
      const sharpWords = Array.from(sharp.querySelectorAll(".motr-w"));
      const done = el.querySelector("#motr-done");
      if (WORDS) sharpWords.forEach((s) => { s.style.visibility = "hidden"; });   // nothing sharp until the cursor is on a word

      // Word boxes in the coordinate frame of #motr-wrap (measured on the blurred layer, which has the same layout
      // as the sharp one). The same boxes decide which word is under the window, so the display and the recorded
      // word geometry cannot disagree.
      const W = wrap.getBoundingClientRect();
      const boxes = Array.from(el.querySelectorAll("#motr-blur .motr-w")).map((s) => {
        const r = s.getBoundingClientRect();
        return [+s.dataset.i, s.textContent, rnd(r.left - W.left), rnd(r.top - W.top), rnd(r.right - W.left), rnd(r.bottom - W.top)];
      });
      const last = boxes[boxes.length - 1], first = boxes[0];
      const N = boxes.length;
      if (BAR) {             // hide the blurred text (it keeps the layout) and draw one grey bar under each line of words
        const blurLayer = el.querySelector("#motr-blur"); blurLayer.style.filter = "none"; blurLayer.style.opacity = "1"; blurLayer.style.visibility = "hidden";
        const lines = {}; boxes.forEach((b) => { const k = b[3]; (lines[k] = lines[k] || []).push(b); });
        Object.values(lines).forEach((ln) => {
          const l = Math.min(...ln.map((b) => b[2])), r = Math.max(...ln.map((b) => b[4])), tp = ln[0][3], bt = ln[0][5], h = (bt - tp) * 0.42;
          const bar = document.createElement("div");
          bar.className = "motr-bar";
          bar.style.cssText = "position:absolute;left:" + l + "px;width:" + (r - l) + "px;top:" + (tp + (bt - tp - h) / 2) + "px;height:" + h + "px;background:#dcdcdc;border-radius:" + (h / 2) + "px;z-index:0";
          wrap.insertBefore(bar, sharp);
        });
        sharp.style.zIndex = "1";
        // a sharp word covers the bar beneath it; the white edge reaches half a space to each side, so no sliver of bar
        // shows between two sharp words
        sharpWords.forEach((s) => { s.style.background = "#fff"; s.style.boxShadow = "0 0 0 3px #fff, 5px 0 0 3px #fff, -5px 0 0 3px #fff"; });
      }

      /* Word under the centre of the window ("words" mode). On the line of a word: inside its box -> that word;
         in the space between two words -> the nearer word; up to half the median space before the first or after
         the last word of a line -> that word. Off the line or farther out -> -1. This is the assignment rule of the
         offline preprocessing (motr_preprocess.R), so "the word that was sharp" and "the word that was read" agree. */
      const gaps = []; for (let k = 0; k + 1 < N; k++) if (boxes[k + 1][3] === boxes[k][3] && boxes[k + 1][2] > boxes[k][4]) gaps.push(boxes[k + 1][2] - boxes[k][4]);
      gaps.sort((a, b) => a - b);
      const EDGE = gaps.length ? gaps[Math.floor(gaps.length / 2)] / 2 : 0;
      const lineTops = Array.from(new Set(boxes.map((b) => b[3])));
      const wordAt = (x, y) => {
        // first the line whose centre is nearest to y (so that two lines can never both match), then the words on it
        let lt = null, best = Infinity;
        for (const tp of lineTops) { const b0 = boxes.find((b) => b[3] === tp), d = Math.abs(y - (b0[3] + b0[5]) / 2); if (d < best) { best = d; lt = tp; } }
        let left = null, right = null;
        for (const [i, , l, tp, r, b] of boxes) {
          if (tp !== lt || y < tp - trial.line_tol || y > b + trial.line_tol) continue;
          if (x >= l && x <= r) return i;
          if (r < x && (left === null || r > left[0])) left = [r, i];
          if (l > x && (right === null || l < right[0])) right = [l, i];
        }
        if (left && right) return (x - left[0] <= right[0] - x) ? left[1] : right[1];
        if (left && x - left[0] <= EDGE) return left[1];
        if (right && right[0] - x <= EDGE) return right[1];
        return -1;
      };

      const samples = [], visLog = [];
      let t0 = null, reachedLast = false, lastWordExit = null, lastSampleT = -1e9;
      let frontier = -1, blocked = 0, visFirst = -2, visLast = -2, pend = null, keysDuring = 0;
      const seen = new Set();
      /* "exit" and "key" modes: reading can end only after the window has been on the first word and then on the
         last one (readToEnd). After an "exit" trial the cursor rests to the right of the sentence, so on the next
         trial the reader first sweeps leftwards across the last word; that sweep must not count as reading. */
      let seenFirst = false, readToEnd = false;
      const show = (a, b, now) => {        // make words a..b sharp (a > b: none), log the change
        if (a === visFirst && b === visLast) return;
        sharpWords.forEach((s, i) => { s.style.visibility = (i >= a && i <= b) ? "visible" : "hidden"; });
        visFirst = a; visLast = b;
        if (t0 !== null) visLog.push([rnd(now - t0), a > b ? -1 : a, a > b ? -1 : b]);
      };
      const onMove = (e) => {
        const now = performance.now();
        /* Cap the sampling rate (Firefox can deliver 1 kHz). An event that comes too soon is not dropped: it is handled
           when the interval has passed, so the display always ends up showing the word under the resting pointer. */
        if (now - lastSampleT < trial.min_sample_ms) { clearTimeout(pend); pend = setTimeout(() => onMove(e), trial.min_sample_ms); return; }
        lastSampleT = now; clearTimeout(pend);
        const R = wrap.getBoundingClientRect();
        const x = e.clientX - R.left, y = e.clientY - R.top;
        const inside = x >= -20 && y >= -20 && x <= R.width + 20 && y <= R.height + 20;
        if (inside && t0 === null) t0 = now;
        if (t0 !== null) samples.push([rnd(now - t0), rnd(x), rnd(y)]);
        const cx = x + trial.focus_dx, cy = y + trial.focus_dy;
        /* The first and last word count as reached by the same rule that makes a word sharp ("words" mode: wordAt, with
           line_tol above and below the line), so a reader whose pointer runs a little above or below the text, and who
           sees every word, can always end the sentence. "ellipse" mode keeps the original box test (+-6 px). */
        const wNow = WORDS ? wordAt(cx, cy) : -2;
        const inBox = (bx) => cx >= bx[2] && cx <= bx[4] && cy >= bx[3] - 6 && cy <= bx[5] + 6;
        const onLast = WORDS ? wNow === N - 1 : inBox(last);
        if (onLast) { reachedLast = true; lastWordExit = now; }
        if (WORDS ? wNow === 0 : inBox(first)) seenFirst = true;
        if (onLast && seenFirst) readToEnd = true;
        if (trial.end_mode === "exit" && readToEnd && t0 !== null && cx > last[4] + trial.exit_px &&
            cy >= last[3] - trial.focus_h && cy <= last[5] + trial.focus_h && now - t0 >= trial.min_reading) { finish(now); return; }
        if (WORDS) {
          const w = wNow;
          if (w === 0) seenFirst = true;
          /* No word is sharp until the window has reached the first word. After an "exit" trial the cursor rests to
             the right of the sentence, and the sweep back to the start would otherwise show the words in reverse
             order (a preview) and, with oneway, lock them. The frontier therefore starts at the first word. */
          if (w < 0 || !seenFirst) { show(1, 0, now); return; }
          frontier = Math.max(frontier, w);
          if (ONEWAY && w < frontier) { blocked += 1; show(1, 0, now); return; }   // going back shows nothing
          seen.add(w);
          let a = Math.max(0, w - SL), b = Math.min(N - 1, w + SR);
          if (ONEWAY) a = Math.max(a, frontier - SL);
          show(a, b, now);
        } else if (trial.focus_shape === "ellipse") {
          sharp.style.clipPath = "ellipse(" + (trial.focus_w / 2) + "px " + (trial.focus_h / 2) + "px at " + cx + "px " + cy + "px)";
        } else {
          const top = cy - trial.focus_h / 2, bot = cy + trial.focus_h / 2;
          const lft = cx - trial.focus_w / 2, rgt = cx + trial.focus_w / 2;
          sharp.style.clipPath = "inset(" + top + "px " + (R.width - rgt) + "px " + (R.height - bot) + "px " + lft + "px)";
        }
      };
      document.addEventListener("mousemove", onMove);

      const hint = document.createElement("p"); hint.style.cssText = "color:#b3452f;text-align:center;min-height:1.4em;margin-top:10px"; el.appendChild(hint);
      let premature = 0, ended = false;
      const finish = (end) => {
        if (ended) return; ended = true;
        document.removeEventListener("mousemove", onMove); document.removeEventListener("keydown", onKey); clearTimeout(pend);
        el.innerHTML = "";
        this.jsPsych.finishTrial({
          motr_samples: JSON.stringify(samples),
          word_boxes: JSON.stringify(boxes),
          vis_log: JSON.stringify(visLog),
          reading_time: t0 === null ? null : rnd(end - t0),
          n_samples: samples.length,
          reached_last_word: reachedLast,
          max_word: frontier,
          blocked_samples: blocked,
          last_word_to_done: lastWordExit === null ? null : rnd(end - lastWordExit),
          premature_clicks: premature,
          done_click_time: end,
          end_mode: trial.end_mode,
          reveal: trial.reveal, span_left: SL, span_right: SR, oneway: ONEWAY, mask: WORDS ? (BAR ? "bar" : "blur") : "ellipse",
          focus_dx: trial.focus_dx, focus_dy: trial.focus_dy, line_tol: trial.line_tol, words_seen: seen.size, keys_during_reading: keysDuring
        });
      };
      const tooEarly = (end) => t0 === null || end - t0 < trial.min_reading || (trial.end_mode !== "button" && !readToEnd);
      const onKey = (e) => {
        if (trial.end_mode !== "key" || (e.key !== " " && e.code !== "Space")) { keysDuring += 1; return; }
        e.preventDefault(); const end = performance.now();
        if (tooEarly(end)) { premature += 1; hint.textContent = "Please move the mouse along the sentence to the last word before pressing SPACE."; return; }
        finish(end); };
      document.addEventListener("keydown", onKey);
      if (done) done.addEventListener("click", () => {
        const end = performance.now();
        if (tooEarly(end)) { premature += 1; hint.textContent = "Please move the mouse along the sentence to read it before clicking Done."; return; }
        finish(end);
      });
      // If the experiment is aborted mid-trial, drop the listeners when the display is cleared.
      const obs = new MutationObserver(() => { if (!document.body.contains(wrap)) { document.removeEventListener("mousemove", onMove); document.removeEventListener("keydown", onKey); obs.disconnect(); } });
      obs.observe(el, { childList: true });
    }
  }
  function rnd(v) { return Math.round(v * 10) / 10; }
  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  MotrPlugin.info = info;
  return MotrPlugin;
})(jsPsychModule);
