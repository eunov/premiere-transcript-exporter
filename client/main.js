/**
 * Transcript Exporter — Panel JavaScript
 *
 * Flow:
 *  1. On load: call getProjectInfo() → populate bin dropdown + sequence list.
 *  2. Bin dropdown change → filter sequence list.
 *  3. Export button:
 *     a. Save project.
 *     b. For each sequence in the selected bin:
 *        i.  Try to get transcript via ExtendScript API.
 *        ii. If none found, parse the .prproj file (Node.js / zlib).
 *        iii.If still nothing, trigger Speech-to-Text and poll until ready.
 *     c. Write .txt files next to .prproj in a /transcripts/ subfolder.
 */

/* global CSInterface, require */
"use strict";

// ─── Node.js (only available when CEP is launched with --enable-nodejs) ─────
// Gated so the panel still boots when Node is disabled. The export flow that
// uses these needs Node and will fail loudly if it runs without them.
let fs = null, zlib = null, path = null;
if (typeof require === "function") {
  try {
    fs   = require("fs");
    zlib = require("zlib");
    path = require("path");
  } catch (e) { /* Node not available */ }
}

// ─── Adobe CEP ───────────────────────────────────────────────────────────────
const cs = new CSInterface();

// ─── State ───────────────────────────────────────────────────────────────────
let projectInfo  = null;  // full data from getProjectInfo()
let allSequences = [];    // [{id, name, binId, binPath}]
let allBins      = [];    // [{id, name, path, sequenceCount}]
let isRunning    = false;
let outputFolder = null;

// ─── DOM ─────────────────────────────────────────────────────────────────────
const projectInfoEl = document.getElementById("project-info");
const binSelect     = document.getElementById("bin-select");
const langSelect    = document.getElementById("lang-select");
const seqListEl     = document.getElementById("sequence-list");
const emptyMsgEl    = document.getElementById("empty-msg");
const exportBtn     = document.getElementById("export-btn");
const statusBar     = document.getElementById("status-bar");
const outputLink    = document.getElementById("output-link");
const refreshBtn    = document.getElementById("refresh-btn");

// ─── Boot ────────────────────────────────────────────────────────────────────
// On panel open, ping the host. If pingHost() returns "pong-42" we know
// host.jsx parsed AND the JSON polyfill installed successfully (because
// pingHost itself returns a plain string with no JSON dependency, but its
// existence proves host.jsx loaded). We then enter normal mode.
// Otherwise we fall back to the diagnostic battery so the failure mode is
// visible without another round-trip to the user.
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(autoBoot, 800);
});
refreshBtn.addEventListener("click", autoBoot);

function autoBoot() {
  setStatus("Initializing host…", "");
  cs.evalScript("pingHost()", function (r) {
    if (r === "pong-42") {
      // Host loaded. Double-check JSON polyfill before normal mode.
      cs.evalScript("jsonProbe()", function (j) {
        if (typeof j === "string" && j.indexOf("JSON_OK") === 0) {
          loadProjectInfo();
        } else {
          console.warn("JSON polyfill check failed:", j);
          runDiagnostics();
        }
      });
    } else {
      console.warn("Host boot ping failed:", r);
      runDiagnostics();
    }
  });
}
binSelect.addEventListener("change",  onBinChange);
exportBtn.addEventListener("click",   runExport);
outputLink.addEventListener("click",  () => {
  // file:// URLs need each path segment URL-encoded so spaces and special
  // chars don't break Finder/Explorer. Without this, "/Volumes/G-DRIVE 6TB/..."
  // fails to open on some systems.
  if (outputFolder) {
    const url = "file://" + outputFolder.split("/").map(encodeURIComponent).join("/");
    cs.openURLInDefaultBrowser(url);
  }
});

// ─── Diagnostic battery ───────────────────────────────────────────────────────
// Renders rows into #sequence-list. Each row: label + result/error.
// Runs sync inspections of the bridge first, then a series of evalScript()
// calls from primitive (2+2) up to our minimal host function.
function runDiagnostics() {
  const list = document.getElementById("sequence-list");
  const empty = document.getElementById("empty-msg");
  if (empty) empty.style.display = "none";
  list.innerHTML = "";
  setStatus("Running diagnostics…", "");

  function row(label, value, klass) {
    const div = document.createElement("div");
    div.className = "seq-row";
    div.style.fontFamily = "ui-monospace, Menlo, monospace";
    div.style.fontSize   = "10px";
    div.style.alignItems = "flex-start";
    div.style.padding    = "3px 6px";
    const safe = (v) => (v === undefined ? "<undefined>" : v === null ? "<null>" : String(v));
    div.innerHTML =
      `<div class="seq-icon ${klass||""}" style="margin-top:3px"></div>` +
      `<div style="flex:1; word-break:break-all; white-space:pre-wrap; line-height:1.35">` +
        `<span style="color:#888">${esc(label)}:</span> ${esc(safe(value))}` +
      `</div>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }

  // ── Sync inspections of the bridge surface ────────────────────────────────
  row("typeof __adobe_cep__", typeof window.__adobe_cep__);
  try {
    const keys = window.__adobe_cep__ ? Object.keys(window.__adobe_cep__).slice(0, 30).join(",") : "n/a";
    row("__adobe_cep__ keys", keys);
  } catch (e) { row("__adobe_cep__ keys", "ERR: " + e.message, "err"); }
  row("typeof __adobe_cep__.evalScript",
      window.__adobe_cep__ ? typeof window.__adobe_cep__.evalScript : "n/a");

  try { row("cs.getApplicationID()",   cs.getApplicationID()); }
  catch (e) { row("cs.getApplicationID()", "ERR: " + e.message, "err"); }
  try { row("cs.getExtensionID()",     cs.getExtensionID()); }
  catch (e) { row("cs.getExtensionID()", "ERR: " + e.message, "err"); }
  try { row("cs.getSystemPath(extension)", cs.getSystemPath("extension")); }
  catch (e) { row("cs.getSystemPath(extension)", "ERR: " + e.message, "err"); }
  try {
    const hc = cs.getHostCapabilities();
    row("getHostCapabilities", JSON.stringify(hc));
  } catch (e) { row("getHostCapabilities", "ERR: " + e.message, "err"); }

  // ── evalScript battery ────────────────────────────────────────────────────
  // Each test gets its own row, with a working spinner replaced on callback.
  const tests = [
    ["typeof JSON",                       "typeof JSON",                                                                  true],
    ["JSON.stringify type",               "(typeof JSON !== 'undefined') ? typeof JSON.stringify : 'JSON undef'",         true],
    ["inline JSON try",                   "(function(){ try { return JSON.stringify({a:1}); } catch(e){ return 'THROW:'+e.toString(); } })()", true],
    ["pingHost()",                        "pingHost()",                                                                   true],
    ["jsonProbe()",                       "jsonProbe()",                                                                  true],
    ["typeof getProjectInfo",             "typeof getProjectInfo",                                                        true],
    ["getProjectInfo() raw",              "getProjectInfo()",                                                             true],
    ["getProjectInfo() try/catch",        "(function(){ try { return getProjectInfo(); } catch(e){ return 'THROW:'+e.toString(); } })()", true],
    ["return literal string",             "'plain-string-no-json'",                                                       true],
    ["return object via toSource",        "({hi:'there'}).toSource()",                                                    true],
    ["app.version",                       "app.version",                                                                  true],
    ["app.project exists",                "(typeof app.project !== 'undefined') ? 'yes' : 'no'",                          true],
    ["cs.evalScript 2+2",                 "2+2",                                                                          false],
  ];

  tests.forEach(([label, script, useBridge], idx) => {
    row(label, "(waiting)", "working");
    const slotIdx = list.children.length - 1;
    const slot    = list.children[slotIdx];
    const cb      = (r) => {
      const safe = (v) => (v === undefined ? "<undefined>" : v === null ? "<null>" : String(v));
      const txt  = safe(r);
      const ok   = txt !== "EvalScript error." && txt !== "<undefined>" && txt !== "";
      slot.innerHTML =
        `<div class="seq-icon ${ok ? "ok" : "err"}" style="margin-top:3px"></div>` +
        `<div style="flex:1; word-break:break-all; white-space:pre-wrap; line-height:1.35; font-family:ui-monospace,Menlo,monospace; font-size:10px">` +
          `<span style="color:#888">${esc(label)}:</span> ${esc(txt)}` +
        `</div>`;
    };
    try {
      if (useBridge) {
        if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
          window.__adobe_cep__.evalScript(script, cb);
        } else {
          cb("BRIDGE MISSING");
        }
      } else {
        cs.evalScript(script, cb);
      }
    } catch (e) { cb("THROW: " + e.message); }
  });

  setStatus("Diagnostics done. Scroll the list for results.", "");
}

// ─── Load project (unused while in diagnostic mode) ──────────────────────────
function loadProjectInfo() {
  if (isRunning) return;
  setStatus("Loading project…", "");
  exportBtn.disabled = true;
  outputLink.style.display = "none";
  binSelect.disabled = true;

  // ── Diagnostic probe: check whether host.jsx actually loaded ───────────────
  // If hostLoaded is false, the JSX file isn't being read by Premiere's
  // ExtendScript engine and getProjectInfo() doesn't exist — that's a
  // manifest/path/loading problem, not a code problem.
  const probe =
    "JSON.stringify({" +
    "hostLoaded: typeof getProjectInfo === 'function'," +
    "appExists: typeof app !== 'undefined'," +
    "projectExists: (typeof app !== 'undefined' && !!app.project)," +
    "projectItemTypeExists: typeof ProjectItemType !== 'undefined'," +
    "esVersion: (typeof $ !== 'undefined' && $.version) ? $.version : 'no $'" +
    "})";
  cs.evalScript(probe, (probeRaw) => {
    let probeMsg = "Probe raw: " + (probeRaw || "<empty>");
    try {
      const probeData = JSON.parse(probeRaw);
      probeMsg = "Probe: hostLoaded=" + probeData.hostLoaded
              + ", app=" + probeData.appExists
              + ", project=" + probeData.projectExists
              + ", ProjectItemType=" + probeData.projectItemTypeExists
              + ", ES=" + probeData.esVersion;
    } catch (e) { /* keep raw fallback */ }
    console.log(probeMsg);
    setStatus(probeMsg, "");
  });

  cs.evalScript("getProjectInfo()", (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.error) {
        projectInfoEl.textContent = "⚠ " + data.error;
        binSelect.innerHTML = "<option value='/'>—</option>";
        renderSequences([]);
        return;
      }

      projectInfo  = data;
      allSequences = data.sequences || [];
      allBins      = data.bins      || [];

      projectInfoEl.textContent = data.name;

      // Populate bin dropdown
      populateBinDropdown();
      binSelect.disabled = false;

      // Render all sequences by default (root "/" selected)
      onBinChange();
      setStatus("", "");

    } catch (e) {
      // Diagnostic: show what the host actually returned so we can tell
      // "JSX file didn't load" (raw === "EvalScript error.") apart from
      // "host returned empty" (raw === "" or undefined) apart from
      // "host returned malformed JSON" (raw is some other string).
      var rawStr = (typeof raw === "undefined") ? "<undefined>"
                 : (raw === null)                ? "<null>"
                 : (raw === "")                  ? "<empty string>"
                 : String(raw);
      var preview = rawStr.length > 300 ? rawStr.slice(0, 300) + "…" : rawStr;
      projectInfoEl.textContent = "⚠ Could not parse project info.\nHost returned: " + preview;
      projectInfoEl.style.whiteSpace = "pre-wrap";
      console.error("evalScript raw output:", raw);
      console.error("JSON.parse error:", e);
    }
  });
}

// ─── Bin dropdown ─────────────────────────────────────────────────────────────
function populateBinDropdown() {
  binSelect.innerHTML = "";

  // Sort: root first, then alphabetical by path depth then name
  const sorted = [...allBins].sort((a, b) => {
    if (a.path === "/") return -1;
    if (b.path === "/") return 1;
    const depthA = (a.path.match(/\//g) || []).length;
    const depthB = (b.path.match(/\//g) || []).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.name.localeCompare(b.name);
  });

  for (const bin of sorted) {
    const opt = document.createElement("option");
    opt.value = bin.path;

    if (bin.path === "/") {
      opt.textContent = `All sequences (${bin.sequenceCount})`;
    } else {
      // Indent sub-bins visually
      const depth = (bin.path.match(/\//g) || []).length - 1;
      const indent = "  ".repeat(Math.max(0, depth - 1));
      opt.textContent = `${indent}📁 ${bin.name} (${bin.sequenceCount})`;
    }

    binSelect.appendChild(opt);
  }
}

function onBinChange() {
  const selectedPath = binSelect.value;

  // Filter sequences whose binPath starts with selectedPath
  let visible;
  if (selectedPath === "/") {
    visible = allSequences;
  } else {
    visible = allSequences.filter(s => s.binPath === selectedPath || s.binPath.startsWith(selectedPath));
  }

  renderSequences(visible);
  exportBtn.disabled = visible.length === 0 || isRunning;
  outputLink.style.display = "none";
  setStatus(visible.length > 0 ? `${visible.length} sequence(s) selected` : "No sequences in this folder.", "");
}

// ─── Render sequence rows ─────────────────────────────────────────────────────
function renderSequences(sequences) {
  Array.from(seqListEl.querySelectorAll(".seq-row")).forEach(el => el.remove());

  if (sequences.length === 0) {
    emptyMsgEl.style.display = "";
    return;
  }
  emptyMsgEl.style.display = "none";

  for (const seq of sequences) {
    const row = document.createElement("div");
    row.className   = "seq-row";
    row.dataset.id  = seq.id;
    row.innerHTML   = `
      <div class="seq-icon"  id="icon-${seq.id}"></div>
      <div class="seq-name"  title="${esc(seq.name)}">${esc(seq.name)}</div>
      <div class="seq-status" id="stat-${seq.id}">–</div>
    `;
    seqListEl.appendChild(row);
  }
}

// ─── Export flow ──────────────────────────────────────────────────────────────
async function runExport() {
  if (isRunning || !projectInfo) return;

  // Export needs Node (fs/path/zlib). The manifest enables this via
  // --enable-nodejs; if it's missing or disabled, fail with a clear message
  // instead of crashing on `path.dirname(undefined)`.
  if (!fs || !path || !zlib) {
    setStatus("Export needs Node.js — check that --enable-nodejs is in the manifest CEFCommandLine.", "err");
    return;
  }
  if (!projectInfo.path) {
    setStatus("Project has no file path on disk. Save the project first.", "err");
    return;
  }

  isRunning = true;
  exportBtn.disabled = true;
  outputLink.style.display = "none";
  resetRowIcons();

  // try/finally guarantees the export button is re-enabled even if any step
  // (await evalScriptAsync, fs.writeFileSync, modal Promise) throws. Without
  // this, a single failure leaves the panel permanently disabled.
  try {
    await runExportInner();
  } catch (e) {
    console.error("Export failed:", e);
    setStatus("Export failed: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    isRunning = false;
    exportBtn.disabled = false;
  }
}

async function runExportInner() {

  const selectedPath = binSelect.value;
  const targets = selectedPath === "/"
    ? allSequences
    : allSequences.filter(s => s.binPath === selectedPath || s.binPath.startsWith(selectedPath));

  // 1. Save project so the .prproj on disk is fresh
  setStatus("Saving project…", "");
  await evalScriptAsync("saveProject()");

  // 2. Set up output folder
  const projectDir      = path.dirname(projectInfo.path);
  const transcriptsDir  = path.join(projectDir, "transcripts");
  if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });
  outputFolder = transcriptsDir;

  const methodMap = {};      // id → how the transcript was obtained
  const textMap   = {};      // id → final transcript text
  const diag      = [];      // diagnostic lines

  // 3. Legacy path: ask the ExtendScript API for a whole-sequence transcript.
  //    Works on older Premiere where a sequence carries its own transcript; on
  //    Premiere 26 this comes back empty and we fall through to slice mode.
  setStatus("Reading transcripts…", "");
  const idList = targets.map(s => s.id);
  try {
    const apiRaw  = await evalScriptAsync(`extractTranscriptsForIds(${JSON.stringify(JSON.stringify(idList))})`);
    const apiData = JSON.parse(apiRaw);
    for (const r of (apiData.results || [])) {
      if (r.text && r.text.trim().length > 0) { textMap[r.id] = r.text; methodMap[r.id] = r.method || "api"; }
    }
  } catch (e) { console.warn("API extraction error:", e); }

  // 4. Slice mode: parse the recording transcript(s) out of the .prproj WITH
  //    timings, then for each sequence read its clip in/out windows and slice
  //    the transcript to just those words. This is what makes a podcast project
  //    (many clips, one shared transcript) export correctly.
  const needsSlice = targets.filter(s => !textMap[s.id]);
  let transcripts = [];
  if (needsSlice.length > 0) {
    setStatus("Parsing project transcript…", "");
    try {
      transcripts = parseTimedTranscripts(projectInfo.path);
      diag.push("Parsed " + transcripts.length + " timed transcript(s): " +
        transcripts.map(t => "doc" + t.objId + "=" + t.wordCount + "w/" + t.span.toFixed(0) + "s").join(", "));
    } catch (e) {
      diag.push("parseTimedTranscripts threw: " + e.message);
    }

    for (const seq of needsSlice) {
      setRowIcon(seq.id, "working", "slicing…");

      let winData = {};
      try { winData = safeJSON(await evalScriptAsync(`getSequenceWindows(${JSON.stringify(seq.id)})`)); }
      catch (e) { winData = {}; }

      const clips = (winData && winData.clips) ? winData.clips : [];
      const rawWindows = clips.filter(c => c.inSec != null && c.outSec != null && (c.outSec - c.inSec) > 0.25);

      if (rawWindows.length === 0) {
        diag.push(seq.name + ": no clip source windows (run from a sequence with linked source clips)");
        continue;
      }
      if (transcripts.length === 0) {
        diag.push(seq.name + ": windows found but project has no transcript to slice");
        continue;
      }

      // A clip's video + audio (and stereo) track items each report the SAME
      // source window, so windows arrive 2–3× over. Group by source media, then
      // pick the source the clip is actually cut from.
      const bySource = {};
      for (const w of rawWindows) {
        const key = w.source || "(unnamed)";
        (bySource[key] = bySource[key] || []).push(w);
      }
      // Music / SFX beds run the full length of a clip, so "most coverage" would
      // pick a music track over the recording — and slicing the transcript at a
      // music cue's timecode yields garbage. The transcript belongs to the
      // SPOKEN recording, so never pick an audio-only source (or an unnamed one).
      const AUDIO_ONLY = /\.(mp3|wav|aif|aiff|m4a|aac|flac|ogg|wma)$/i;
      function coverageOf(key) {
        let cov = 0;
        for (const w of dedupeWindows(bySource[key])) cov += (w.outSec - w.inSec);
        return cov;
      }
      const srcCov = [];
      let bestSrc = null, bestCov = -1;
      for (const key in bySource) {
        const cov = coverageOf(key);
        srcCov.push(key + "=" + cov.toFixed(0) + "s");
        if (AUDIO_ONLY.test(key) || key === "(unnamed)") continue;  // skip music/SFX
        if (cov > bestCov) { bestCov = cov; bestSrc = key; }
      }
      // Fall back to the largest source only if every source was audio/unnamed.
      if (bestSrc === null) {
        for (const key in bySource) {
          const cov = coverageOf(key);
          if (cov > bestCov) { bestCov = cov; bestSrc = key; }
        }
      }

      const windows = dedupeWindows(bySource[bestSrc]).sort((a, b) => (a.startSec || 0) - (b.startSec || 0));
      const nestedWarn = /sequence/i.test(bestSrc) ? " [⚠ nested sequence — timecodes may be relative]" : "";

      // Slice from the largest transcript whose span covers these windows.
      const maxOut = Math.max.apply(null, windows.map(w => w.outSec));
      const src = transcripts.find(t => t.span >= maxOut - 1) || transcripts[0];

      const parts = [];
      const winLabels = [];
      for (const w of windows) {
        const txt = sliceWords(src.words, w.inSec, w.outSec);
        winLabels.push(w.inSec.toFixed(0) + "-" + w.outSec.toFixed(0));
        if (txt && txt.trim().length > 0) parts.push(txt.trim());
      }
      const joined = parts.join(" ").trim();

      if (joined.length > 0) {
        textMap[seq.id]   = joined;
        methodMap[seq.id] = "slice doc" + src.objId;
        diag.push(seq.name + ': source "' + bestSrc + '"' + nestedWarn + " (sources: " + srcCov.join(", ") + "); " +
          windows.length + " window(s) [" + winLabels.join(", ") + "]s → " +
          joined.split(/\s+/).length + " words from doc" + src.objId);
      } else {
        diag.push(seq.name + ': source "' + bestSrc + '", window(s) [' + winLabels.join(", ") +
          "]s produced no words (source may not be the transcribed recording)");
      }
    }
  }

  // 5. Write .txt files
  let ok = 0, skipped = 0;
  setStatus("Writing files…", "");
  const usedFilenames = new Set();
  for (const seq of targets) {
    const text     = textMap[seq.id] || null;
    const method   = methodMap[seq.id] || "none";
    const baseName = sanitize(seq.name);
    // Two sequences with the same name would silently overwrite each other —
    // append a counter to keep both.
    let fileName = baseName + ".txt";
    let n = 2;
    while (usedFilenames.has(fileName.toLowerCase())) { fileName = baseName + " (" + n + ").txt"; n++; }
    usedFilenames.add(fileName.toLowerCase());
    const outPath = path.join(transcriptsDir, fileName);

    const cleaned = text ? cleanTranscript(text) : "";
    if (cleaned.length >= 20) {
      try {
        fs.writeFileSync(outPath, cleaned, "utf8");
        setRowIcon(seq.id, "ok", method);
        ok++;
      } catch (e) {
        setRowIcon(seq.id, "err", "write error: " + e.message);
        skipped++;
      }
    } else {
      const icon = document.getElementById("icon-" + seq.id);
      if (icon && !icon.classList.contains("warn")) setRowIcon(seq.id, "warn", "no transcript");
      skipped++;
    }
  }

  // 6. Diagnostic file (so failures are explainable without the console)
  try {
    const lines = ["Transcript slice diagnostic", "Generated: " + new Date().toISOString(), ""];
    for (const d of diag) lines.push(d);
    lines.push("");
    for (const seq of targets) {
      const t = textMap[seq.id];
      lines.push("--- " + seq.name + " --- " + (t ? ("WROTE via " + (methodMap[seq.id] || "?")) : "EMPTY"));
    }
    fs.writeFileSync(path.join(transcriptsDir, "_diagnostic.txt"), lines.join("\n"), "utf8");
  } catch (e) { console.warn("Could not write diagnostic file:", e); }

  // 7. Final status
  if (skipped === 0) {
    setStatus(`✓ ${ok} transcript(s) exported.`, "ok");
  } else {
    setStatus(`${ok} exported, ${skipped} skipped — see _diagnostic.txt for why.`, ok > 0 ? "" : "err");
  }

  if (ok > 0) outputLink.style.display = "block";
}

// ─── Poll for transcript ──────────────────────────────────────────────────────
/**
 * Repeatedly calls checkTranscript() via ExtendScript until text appears
 * or we hit the timeout.
 *
 * @param {string} seqId
 * @param {number} maxSeconds   how long to wait total
 * @param {number} intervalMs   how often to check
 * @returns {Promise<string|null>}
 */
async function pollForTranscript(seqId, maxSeconds, intervalMs) {
  const deadline = Date.now() + maxSeconds * 1000;
  let elapsed = 0;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    elapsed += intervalMs;

    const raw    = await evalScriptAsync(`checkTranscript(${JSON.stringify(seqId)})`);
    const result = safeJSON(raw);

    if (result.hasTranscript && result.text) return result.text;

    // Update the status dot to show elapsed time
    const elapsedSec = Math.round(elapsed / 1000);
    setRowStatus(seqId, `${elapsedSec}s…`);
  }

  return null;
}

// ─── Timed-transcript parsing + slicing (podcast / shared-source projects) ───
// In a podcast-style project, many short clips are cut from ONE long recording
// that has a single transcript. There is no per-clip transcript to grab — so we
// read the recording's transcript out of the .prproj WITH word-level timings,
// then slice it to just the words inside each clip's source in/out window.
//
// Each transcript is a FlatBuffer of word records. A word record is a table
// whose fields are: slot 0 = start time (Premiere ticks, int64), slot 1 =
// duration (ticks), slot 2 = the word string. Dividing ticks by the tick rate
// gives seconds, which line up with a clip's inPoint/outPoint from getSequenceWindows().
const PPRO_TICKS = 254016000000;

// Read every timed transcript out of the project file. Returns
// [{ objId, words:[{s, start}], span, wordCount }], longest transcript first.
function parseTimedTranscripts(prprojPath) {
  const buffer = fs.readFileSync(prprojPath);
  const xml = decompressProjectFile(buffer);
  const docs = [];
  const re = /<ExternallyProvidedTranscriptDocument ObjectID="(\d+)"[^>]*>[\s\S]*?<TranscriptData Encoding="base64"[^>]*>([\s\S]*?)<\/TranscriptData>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const objId = m[1];
    const b64 = m[2].replace(/\s+/g, "");
    const words = decodeTimedWords(b64);
    if (words.length === 0) continue;   // empty / placeholder transcript
    let span = 0;
    for (const w of words) if (w.start > span) span = w.start;
    docs.push({ objId, words, span, wordCount: words.length });
  }
  docs.sort((a, b) => b.wordCount - a.wordCount);
  return docs;
}

// Recover [{s, start(seconds)}] from one base64 transcript FlatBuffer.
function decodeTimedWords(base64) {
  if (!base64 || base64.length < 200) return [];
  let buf;
  try { buf = Buffer.from(base64, "base64"); } catch (e) { return []; }

  // 1. Index every FlatBuffer string object that looks like a transcript word.
  //    Strings are stored as [uint32 length][utf8 bytes][NUL].
  const bySp = Object.create(null);
  for (let i = 0; i < buf.length - 4; i++) {
    const len = buf.readUInt32LE(i);
    if (len < 1 || len > 120) continue;
    if (i + 4 + len >= buf.length) continue;
    if (buf[i + 4 + len] !== 0) continue;
    let ok = true;
    for (let j = 0; j < len; j++) {
      const b = buf[i + 4 + j];
      if (b < 0x09 || (b > 0x0a && b < 0x20)) { ok = false; break; }
    }
    if (!ok) continue;
    const s = buf.slice(i + 4, i + 4 + len).toString("utf8");
    if (isTranscriptWord(s)) bySp[i] = s;
  }

  // 2. Find string-field pointers: a uint32 offset that resolves to a string.
  const words = [];
  for (let P = 0; P < buf.length - 4; P++) {
    const off = buf.readUInt32LE(P);
    if (off < 4 || off >= 200) continue;
    const target = P + off;
    const s = bySp[target];
    if (s === undefined) continue;
    if (s === "en-us" || s === "Unknown" || s === "und-zz") continue;

    // 3. Resolve the word's table via the vtable; slot 0 = start ticks.
    const fields = resolveFlatBufferTable(buf, P);
    if (!fields) continue;
    const p0 = fields[0];
    if (p0 == null || p0 + 8 > buf.length) continue;
    const startTicks = readU64LE(buf, p0);
    if (startTicks == null) continue;
    words.push({ s, start: startTicks / PPRO_TICKS });
  }

  words.sort((a, b) => a.start - b.start);
  return words;
}

// Walk back from a string-field position to the FlatBuffer table that owns it,
// returning the absolute positions of each field slot. The vtable header is
// u16 vtableSize, u16 tableSize, then u16 field offsets relative to the table.
function resolveFlatBufferTable(buf, P) {
  for (let T = P; T >= P - 60 && T >= 0; T--) {
    const soff = buf.readInt32LE(T);
    const vt = T - soff;
    if (vt < 0 || vt + 4 > buf.length) continue;
    const vtSize = buf.readUInt16LE(vt);
    const tblSize = buf.readUInt16LE(vt + 2);
    if (vtSize < 4 || vtSize > 64 || (vtSize % 2) || tblSize < 4 || tblSize > 128) continue;
    const fields = [];
    let hit = false;
    for (let o = vt + 4; o + 2 <= vt + vtSize; o += 2) {
      const foff = buf.readUInt16LE(o);
      const pos = foff ? T + foff : null;
      fields.push(pos);
      if (pos === P) hit = true;
    }
    if (hit) return fields;
  }
  return null;
}

// Read a little-endian uint64 as a JS number (transcript times stay well under
// 2^53, so precision is exact). Avoids BigInt, which old CEP Node lacks.
function readU64LE(buf, pos) {
  if (pos == null || pos + 8 > buf.length) return null;
  const lo = buf.readUInt32LE(pos);
  const hi = buf.readUInt32LE(pos + 4);
  return hi * 4294967296 + lo;
}

function isTranscriptWord(s) {
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/[@|`={}<>%#$^~\[\]\\\/+*]/.test(s)) return false;
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  return letters / s.length >= 0.6;
}

// Slice a timed word list to the half-open window [inSec, outSec) and join.
function sliceWords(words, inSec, outSec) {
  const out = [];
  for (const w of words) {
    if (w.start >= inSec && w.start < outSec) out.push(w.s);
  }
  return out.join(" ");
}

// Collapse identical source windows (a clip's video + audio + stereo track items
// all report the same [inSec, outSec], which would otherwise slice — and
// concatenate — the same words two or three times).
function dedupeWindows(ws) {
  const seen = Object.create(null);
  const out = [];
  for (const w of ws) {
    const k = w.inSec.toFixed(2) + "|" + w.outSec.toFixed(2);
    if (seen[k]) continue;
    seen[k] = true;
    out.push(w);
  }
  return out;
}

// ─── Project file parser ──────────────────────────────────────────────────────
// Premiere Pro 2025/2026 stores transcripts inside the .prproj (gzipped XML)
// as base64 FlatBuffer blobs in <ExternallyProvidedTranscriptDocument><TranscriptData>.
// ExtendScript can't reach them (the relevant APIs were removed), so we read
// the file directly here.
//
// Words in the FlatBuffer are emitted in REVERSED temporal order (a quirk of
// how FlatBuffer offsets serialize). Reversing the recovered string list
// yields readable transcripts.
//
// We don't have a clean XML-level link from sequenceID to transcript doc, so
// we match by content overlap with the sequence's name.
function parseProjectFile(prprojPath, sequences /* [{id, name}] */) {
  const diagnostic = [];
  const buffer = fs.readFileSync(prprojPath);
  diagnostic.push("Read " + buffer.length + " bytes from " + prprojPath);

  const xml = decompressProjectFile(buffer);
  diagnostic.push("Decompressed XML: " + xml.length + " bytes");

  // Extract every transcript document
  const docs = [];
  const re = /<ExternallyProvidedTranscriptDocument ObjectID="(\d+)"[^>]*>[\s\S]*?<TranscriptData Encoding="base64"[^>]*>([\s\S]*?)<\/TranscriptData>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const objId = m[1];
    const b64 = m[2].replace(/\s+/g, "");
    const text = decodeFlatBufferTranscript(b64);
    docs.push({ objId, text, wc: text ? text.split(/\s+/).filter(Boolean).length : 0 });
  }
  diagnostic.push("Found " + docs.length + " transcript document(s); word counts: " +
    docs.map(d => d.objId + "=" + d.wc).join(", "));

  // Match each sequence to its best-scoring transcript.
  // Dedicated transcripts run 100-500 words and open with the topic; full
  // session transcripts run tens of thousands of words and mention the topic
  // in passing. We strongly prefer the dedicated transcripts.
  const SHORT_DOC = 500;
  const matches = {};
  const usedSeq = new Set();
  const usedDoc = new Set();

  // PASS 1: only dedicated transcripts (< 500 words).
  // Score threshold: 1 (any keyword match in body OR head).
  let pass1 = [];
  for (const seq of sequences) {
    for (const d of docs) {
      if (d.wc < 20 || d.wc >= SHORT_DOC) continue;
      const score = scoreNameMatch(seq.name, d.text);
      if (score >= 1) pass1.push({ seqId: seq.id, seqName: seq.name, objId: d.objId, text: d.text, score, wc: d.wc });
    }
  }
  pass1.sort((a, b) => b.score - a.score || a.wc - b.wc);
  for (const c of pass1) {
    if (usedSeq.has(c.seqId) || usedDoc.has(c.objId)) continue;
    matches[c.seqId] = c.text;
    usedSeq.add(c.seqId);
    usedDoc.add(c.objId);
    diagnostic.push("MATCH (pass1 dedicated) score=" + c.score + " words=" + c.wc + ' "' + c.seqName + '" <- doc ' + c.objId);
  }

  // PASS 2: for any still unmatched, allow larger docs.
  // Score threshold: 5 (stronger requirement to avoid false-positives in big docs).
  let pass2 = [];
  for (const seq of sequences) {
    if (usedSeq.has(seq.id)) continue;
    for (const d of docs) {
      if (usedDoc.has(d.objId)) continue;
      if (d.wc < 20) continue;
      const score = scoreNameMatch(seq.name, d.text);
      if (score >= 5) pass2.push({ seqId: seq.id, seqName: seq.name, objId: d.objId, text: d.text, score, wc: d.wc });
    }
  }
  pass2.sort((a, b) => b.score - a.score || a.wc - b.wc);
  for (const c of pass2) {
    if (usedSeq.has(c.seqId) || usedDoc.has(c.objId)) continue;
    matches[c.seqId] = c.text;
    usedSeq.add(c.seqId);
    usedDoc.add(c.objId);
    diagnostic.push("MATCH (pass2 long-doc) score=" + c.score + " words=" + c.wc + ' "' + c.seqName + '" <- doc ' + c.objId);
  }

  for (const seq of sequences) {
    if (!matches[seq.id]) diagnostic.push("NO MATCH: " + seq.name + " (name keywords absent from all transcripts; check _unmatched_docs.txt for available unused transcripts)");
  }

  // Collect dedicated transcripts (< 500 words) that weren't assigned to any
  // sequence. Useful when a sequence's title is topical and not a quote
  // (e.g. "Decisiion Trifecta") — user can read the previews and pick the
  // right one manually.
  const unmatched = [];
  for (const d of docs) {
    if (usedDoc.has(d.objId)) continue;
    if (d.wc < 20 || d.wc >= SHORT_DOC) continue;
    unmatched.push({ objId: d.objId, wc: d.wc, preview: d.text.substring(0, 300), text: d.text });
  }

  return { matches, diagnostic, unmatched };
}

function decodeFlatBufferTranscript(base64) {
  if (!base64 || base64.length < 200) return "";
  let buf;
  try { buf = Buffer.from(base64, "base64"); } catch (e) { return ""; }

  // Scan for FlatBuffer-style length-prefixed strings (UInt32LE length, then UTF-8).
  const strings = [];
  for (let i = 0; i < buf.length - 4; i++) {
    const len = buf.readUInt32LE(i);
    if (len < 1 || len > 200) continue;
    if (i + 4 + len > buf.length) continue;

    let valid = true;
    for (let j = 0; j < len; j++) {
      const b = buf[i + 4 + j];
      if (b === 0) { valid = false; break; }
      // Allow tab/LF, printable ASCII, and UTF-8 high bytes
      if (b < 0x20 && b !== 0x09 && b !== 0x0a) { valid = false; break; }
      if (b > 0x7e && b < 0xc0) { valid = false; break; }
    }
    if (!valid) continue;

    const s = buf.slice(i + 4, i + 4 + len).toString("utf8");
    if (isWordlike(s)) strings.push(s);
  }

  // Reverse: Premiere serializes words in temporal-reverse order.
  strings.reverse();

  // Dedupe adjacent identical runs (the scanner finds the same string at
  // multiple FlatBuffer offsets).
  const out = [];
  let prev = "";
  for (const s of strings) {
    if (s === prev) continue;
    out.push(s);
    prev = s;
  }

  return out.join(" ");
}

// Heuristic: real transcript words contain only standard punctuation. Binary
// noise contains @, |, `, =, <>, {}, etc.
const ALLOWED_2CHAR = new Set([
  "is","in","it","of","or","on","at","to","be","by","do","go","he","we","my","an","as",
  "ok","oh","ow","ya","ah","um","uh","aw","ew","hi","ho","no","so","up","us","if","ms","mr","st","i'd","i'm","ll"
]);
function isWordlike(s) {
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/[@|`={}<>%#$^~\[\]\\\/+*]/.test(s)) return false;
  // 1-char: only "a", "A", "I"
  if (s.length === 1 && !/[aAI]/.test(s)) return false;
  // 2-char: reject unless on the allowed list (filters "pY", "lf", "8n" noise)
  if (s.length === 2 && !ALLOWED_2CHAR.has(s.toLowerCase())) return false;
  // Reject very short numbers/digit-led strings (FlatBuffer offset noise)
  if (/^\d/.test(s) && s.length < 4) return false;
  const stripped = s.replace(/[.,!?\s]+$/, "").toLowerCase();
  if (stripped === "en-us" || stripped === "und-zz" || stripped === "unknown") return false;
  // Reject strings that are mostly digits/punctuation
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (letters / s.length < 0.6) return false;
  return true;
}

// Score how well a sequence name maps to a transcript's content.
// Searches anywhere in the transcript, with bonuses for matches near the start
// (dedicated transcripts open with their topic).
function scoreNameMatch(seqName, transcript) {
  if (!seqName || !transcript) return 0;
  const stop = new Set(["the","a","an","on","in","of","and","or","is","are","was","to","for","at","by","my","i","it","that","this"]);
  const keywords = seqName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !stop.has(w));
  if (keywords.length === 0) return 0;

  const full = transcript.toLowerCase();
  const head = full.substring(0, 500);
  let score = 0;
  for (const k of keywords) {
    if (head.indexOf(k) >= 0) score += 2;       // strong: in opening
    else if (full.indexOf(k) >= 0) score += 1;  // weak: anywhere
  }
  // Bonus for all keywords present somewhere
  if (keywords.every(k => full.indexOf(k) >= 0) && keywords.length > 1) score += 3;
  // Big bonus for the exact phrase
  if (head.indexOf(seqName.toLowerCase()) >= 0) score += 10;
  else if (full.indexOf(seqName.toLowerCase()) >= 0) score += 5;
  return score;
}

function decompressProjectFile(buffer) {
  try { return zlib.inflateSync(buffer).toString("utf8");     } catch (e) {}
  try { return zlib.gunzipSync(buffer).toString("utf8");      } catch (e) {}
  try { return zlib.inflateRawSync(buffer).toString("utf8");  } catch (e) {}
  return buffer.toString("utf8");
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function cleanTranscript(text) {
  return text
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeJSON(raw) {
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setStatus(msg, cls) {
  statusBar.textContent = msg;
  statusBar.className   = cls || "";
}

function setRowIcon(seqId, state, label) {
  const icon = document.getElementById("icon-" + seqId);
  const stat = document.getElementById("stat-" + seqId);
  if (icon) icon.className = "seq-icon " + (state || "");
  if (stat) {
    stat.textContent = label || "";
    stat.className   = "seq-status " + (state === "ok" ? "ok" : state === "err" ? "err" : state === "warn" ? "warn" : "");
  }
}

function setRowStatus(seqId, label) {
  const stat = document.getElementById("stat-" + seqId);
  if (stat) stat.textContent = label;
}

function resetRowIcons() {
  document.querySelectorAll(".seq-icon").forEach(el => { el.className = "seq-icon"; });
  document.querySelectorAll(".seq-status").forEach(el => { el.textContent = "–"; el.className = "seq-status"; });
}

function evalScriptAsync(script) {
  return new Promise(resolve => cs.evalScript(script, resolve));
}

// ─── Manual transcript-assignment modal ──────────────────────────────────────
// Native <select> dropdowns can fail to render their options inside CEP
// panels, so this uses click-to-select cards instead. Reliable.
function promptForAssignments(orphans, availableDocs) {
  return new Promise((resolve) => {
    const selection = {}; // seqId -> docId | null

    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed; inset:0; background:rgba(0,0,0,0.78); z-index:1000;" +
      "display:flex; align-items:center; justify-content:center;";

    const card = document.createElement("div");
    card.style.cssText =
      "background:#272727; border:1px solid #3a3a3a; border-radius:6px;" +
      "padding:16px; width:95%; max-width:560px; max-height:88vh;" +
      "overflow-y:auto; color:#d4d4d4; font-size:11px;";

    const title = document.createElement("div");
    title.textContent = "Assign transcripts (" + orphans.length + " unmatched, " + availableDocs.length + " available)";
    title.style.cssText = "font-size:13px; font-weight:600; color:#fff; margin-bottom:6px;";
    card.appendChild(title);

    const desc = document.createElement("div");
    desc.textContent =
      "Click a transcript card to assign it to the sequence above it. " +
      "Click again to deselect (sequence stays empty). Apply when done.";
    desc.style.cssText = "color:#888; margin-bottom:14px; line-height:1.4;";
    card.appendChild(desc);

    if (availableDocs.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No unused dedicated transcripts found in the project. " +
                          "Run Speech-to-Text on the missing sequence(s) in Premiere's Text panel.";
      empty.style.cssText = "color:#e05252; padding:10px; background:#2a1a1a; border-radius:3px;";
      card.appendChild(empty);
    }

    for (const seq of orphans) {
      const block = document.createElement("div");
      block.style.cssText = "margin-bottom:14px; border-top:1px solid #3a3a3a; padding-top:10px;";

      const lbl = document.createElement("div");
      lbl.textContent = "▸ " + seq.name;
      lbl.style.cssText = "color:#fff; font-weight:600; margin-bottom:6px; font-size:12px;";
      block.appendChild(lbl);

      const cardEls = []; // for cross-deselection within this orphan

      for (const d of availableDocs) {
        const docCard = document.createElement("div");
        docCard.style.cssText =
          "padding:7px 9px; margin-bottom:4px; background:#1e1e1e;" +
          "border:1px solid #3a3a3a; border-radius:3px; cursor:pointer;" +
          "transition:background 0.1s, border-color 0.1s;";
        docCard.dataset.docId = d.objId;

        const meta = document.createElement("div");
        meta.textContent = "doc " + d.objId + " · " + d.wc + " words";
        meta.style.cssText = "color:#888; font-size:9px; margin-bottom:3px; letter-spacing:0.04em;";
        docCard.appendChild(meta);

        const prev = document.createElement("div");
        prev.textContent = d.preview.replace(/\s+/g, " ").substring(0, 220) +
                           (d.preview.length > 220 ? "…" : "");
        prev.style.cssText = "color:#d4d4d4; line-height:1.4;";
        docCard.appendChild(prev);

        docCard.addEventListener("mouseenter", () => {
          if (selection[seq.id] !== d.objId) docCard.style.background = "#2a2a2a";
        });
        docCard.addEventListener("mouseleave", () => {
          if (selection[seq.id] !== d.objId) docCard.style.background = "#1e1e1e";
        });
        docCard.addEventListener("click", () => {
          if (selection[seq.id] === d.objId) {
            // Toggle off
            delete selection[seq.id];
            docCard.style.background = "#1e1e1e";
            docCard.style.borderColor = "#3a3a3a";
          } else {
            selection[seq.id] = d.objId;
            for (const other of cardEls) {
              other.style.background = "#1e1e1e";
              other.style.borderColor = "#3a3a3a";
            }
            docCard.style.background = "#1f3a5e";
            docCard.style.borderColor = "#3b8eea";
          }
        });

        cardEls.push(docCard);
        block.appendChild(docCard);
      }

      card.appendChild(block);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex; gap:8px; margin-top:14px; padding-top:10px; border-top:1px solid #3a3a3a;";

    function mkBtn(text, primary) {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText =
        "padding:7px 14px; border:none; border-radius:3px; cursor:pointer;" +
        "font-size:11px; font-weight:600;" +
        (primary ? "background:#3b8eea; color:#fff;"
                 : "background:#383838; color:#d4d4d4;");
      return b;
    }

    function closeWith(result) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    }
    function collectAssignments() {
      const out = {};
      for (const seqId in selection) {
        const docId = selection[seqId];
        if (!docId) continue;
        const doc = availableDocs.find(d => d.objId === docId);
        if (doc) out[seqId] = { text: doc.text, docId: doc.objId };
      }
      return out;
    }

    const applyBtn = mkBtn("Apply and Continue", true);
    applyBtn.addEventListener("click", () => closeWith(collectAssignments()));
    btnRow.appendChild(applyBtn);

    const skipBtn = mkBtn("Skip All", false);
    skipBtn.addEventListener("click", () => closeWith({}));
    btnRow.appendChild(skipBtn);

    card.appendChild(btnRow);
    overlay.appendChild(card);

    // Keyboard: Enter = apply, Escape = skip-all.
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); closeWith({}); }
      else if (e.key === "Enter") { e.preventDefault(); closeWith(collectAssignments()); }
    }
    document.addEventListener("keydown", onKey);

    // Click outside the card dismisses with skip-all.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeWith({});
    });

    document.body.appendChild(overlay);
  });
}
