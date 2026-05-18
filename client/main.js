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

// ─── Node.js (available in CEP via --enable-nodejs) ──────────────────────────
const fs   = require("fs");
const zlib = require("zlib");
const path = require("path");

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
document.addEventListener("DOMContentLoaded", loadProjectInfo);
refreshBtn.addEventListener("click",  loadProjectInfo);
binSelect.addEventListener("change",  onBinChange);
exportBtn.addEventListener("click",   runExport);
outputLink.addEventListener("click",  () => {
  if (outputFolder) cs.openURLInDefaultBrowser("file://" + outputFolder);
});

// ─── Load project ─────────────────────────────────────────────────────────────
function loadProjectInfo() {
  if (isRunning) return;
  setStatus("Loading project…", "");
  exportBtn.disabled = true;
  outputLink.style.display = "none";
  binSelect.disabled = true;

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
      projectInfoEl.textContent = "⚠ Could not parse project info.";
      console.error(e);
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
  isRunning = true;
  exportBtn.disabled = true;
  outputLink.style.display = "none";
  resetRowIcons();

  const selectedPath = binSelect.value;
  const targets = selectedPath === "/"
    ? allSequences
    : allSequences.filter(s => s.binPath === selectedPath || s.binPath.startsWith(selectedPath));

  const lang = langSelect.value;

  // 1. Save project so .prproj on disk is fresh
  setStatus("Saving project…", "");
  await evalScriptAsync("saveProject()");

  // 2. Set up output folder
  const projectDir      = path.dirname(projectInfo.path);
  const transcriptsDir  = path.join(projectDir, "transcripts");
  if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });
  outputFolder = transcriptsDir;

  // 3. Extract transcripts via ExtendScript API for all targets at once
  setStatus("Reading transcripts…", "");
  const idList = targets.map(s => s.id);
  let apiMap   = {}; // id → text

  try {
    const apiRaw  = await evalScriptAsync(`extractTranscriptsForIds(${JSON.stringify(JSON.stringify(idList))})`);
    const apiData = JSON.parse(apiRaw);
    for (const r of (apiData.results || [])) {
      if (r.text && r.text.trim().length > 0) apiMap[r.id] = r.text;
    }
  } catch (e) { console.warn("API extraction error:", e); }

  // 4. For sequences with no API text, try parsing the .prproj file
  const needsFile = targets.filter(s => !apiMap[s.id]);
  let parsedMap   = {};
  if (needsFile.length > 0) {
    setStatus("Parsing project file…", "");
    try {
      parsedMap = parseProjectFile(projectInfo.path, needsFile.map(s => s.id));
    } catch (e) { console.error("Project file parse error:", e); }
  }

  // 5. Identify sequences that still have no transcript → auto-transcribe
  const needsTranscription = targets.filter(s => !apiMap[s.id] && !parsedMap[s.id]);

  if (needsTranscription.length > 0) {
    setStatus(`Transcribing ${needsTranscription.length} sequence(s)…`, "");

    for (const seq of needsTranscription) {
      setRowIcon(seq.id, "working", "transcribing…");
      const triggerRaw = await evalScriptAsync(
        `triggerTranscription(${JSON.stringify(seq.id)}, ${JSON.stringify(lang)})`
      );
      const triggerResult = safeJSON(triggerRaw);

      if (!triggerResult.success) {
        // Can't trigger transcription — mark as skipped
        setRowIcon(seq.id, "warn", "manual STT needed");
        continue;
      }

      // Poll until transcript appears (up to ~3 minutes)
      const text = await pollForTranscript(seq.id, 180, 4000);

      if (text) {
        apiMap[seq.id] = text;
        setRowIcon(seq.id, "ok", "transcribed");
      } else {
        setRowIcon(seq.id, "warn", "timed out");
      }
    }
  }

  // 6. Write .txt files
  let ok = 0, skipped = 0;
  setStatus("Writing files…", "");

  for (const seq of targets) {
    const text = apiMap[seq.id] || parsedMap[seq.id] || null;
    const fileName = sanitize(seq.name) + ".txt";
    const outPath  = path.join(transcriptsDir, fileName);

    if (text && text.trim().length > 0) {
      try {
        fs.writeFileSync(outPath, cleanTranscript(text), "utf8");
        setRowIcon(seq.id, "ok", "saved");
        ok++;
      } catch (e) {
        setRowIcon(seq.id, "err", "write error");
        skipped++;
      }
    } else {
      // Only mark warn if we didn't already set a status for this row
      const icon = document.getElementById("icon-" + seq.id);
      if (icon && !icon.classList.contains("warn")) {
        setRowIcon(seq.id, "warn", "no transcript");
      }
      skipped++;
    }
  }

  // 7. Final status
  if (skipped === 0) {
    setStatus(`✓ ${ok} transcript(s) exported.`, "ok");
  } else {
    setStatus(
      `${ok} exported, ${skipped} skipped.` +
      (skipped > 0 ? " Yellow rows need Speech to Text in Premiere's Text panel." : ""),
      ok > 0 ? "" : "err"
    );
  }

  if (ok > 0) outputLink.style.display = "block";

  isRunning = false;
  exportBtn.disabled = false;
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

// ─── Project file parser ──────────────────────────────────────────────────────
function parseProjectFile(prprojPath, sequenceIds) {
  const buffer = fs.readFileSync(prprojPath);
  const xml    = decompressProjectFile(buffer);
  const result = {};

  for (const seqId of sequenceIds) {
    const block = extractSequenceBlock(xml, seqId);
    if (!block) continue;

    const text = (
      extractByPattern(block, /<Text>([\s\S]*?)<\/Text>/g)               ||
      extractByPattern(block, /<CaptionText>([\s\S]*?)<\/CaptionText>/g) ||
      extractByPattern(block, /<Transcript>([\s\S]*?)<\/Transcript>/g)   ||
      extractByPattern(block, /<SpeechTranscript>([\s\S]*?)<\/SpeechTranscript>/g) ||
      extractByPattern(block, /<Caption[^>]*>([\s\S]*?)<\/Caption>/g)    ||
      extractByPattern(block, /CaptionText="([^"]+)"/g)                  ||
      extractWordLevelText(block)
    );

    if (text) result[seqId] = text;
  }

  return result;
}

function decompressProjectFile(buffer) {
  try { return zlib.inflateSync(buffer).toString("utf8");     } catch (e) {}
  try { return zlib.gunzipSync(buffer).toString("utf8");      } catch (e) {}
  try { return zlib.inflateRawSync(buffer).toString("utf8");  } catch (e) {}
  return buffer.toString("utf8");
}

function extractSequenceBlock(xml, seqId) {
  const safe = escapeRegex(seqId);

  // ObjectUID attribute
  const m1 = xml.match(new RegExp(`ObjectUID="${safe}"[\\s\\S]{0,6000}`));
  if (m1) return m1[0];

  // Plain text content reference
  const m2 = xml.match(new RegExp(`<SequenceID>[^<]*${safe}[^<]*<\\/SequenceID>[\\s\\S]{0,6000}`));
  if (m2) return m2[0];

  // Smaller project: search the whole file
  if (xml.length < 6_000_000) return xml;
  return null;
}

function extractByPattern(xml, pattern) {
  const chunks = [];
  let m;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(xml)) !== null) {
    const t = stripXml(m[1]).trim();
    if (t.length > 0) chunks.push(t);
  }
  return chunks.length > 0 ? chunks.join(" ") : null;
}

function extractWordLevelText(xml) {
  const words = [];
  const pat   = /<Word[^>]*>([\s\S]*?)<\/Word>/g;
  let m;
  while ((m = pat.exec(xml)) !== null) {
    const w = stripXml(m[1]).trim();
    if (w.length > 0) words.push(w);
  }
  return words.length > 3 ? words.join(" ") : null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function stripXml(s) {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
