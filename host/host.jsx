/**
 * Transcript Exporter — ExtendScript host
 *
 * ExtendScript engine 4.5.6 (Premiere Pro 26+) does NOT ship a native JSON
 * object. The polyfill below adds JSON.stringify and JSON.parse so the rest
 * of this file can talk to the panel in JSON. Source is pure ASCII — no
 * literal control chars or unicode in regex character classes, which the
 * 4.5.6 parser refuses to load.
 */

if (typeof JSON !== "object") { JSON = {}; }
(function () {
    function quote(s) {
        var r = "\"";
        for (var i = 0; i < s.length; i++) {
            var cc = s.charCodeAt(i);
            if (cc === 92)      { r += "\\\\"; }
            else if (cc === 34) { r += "\\\""; }
            else if (cc === 8)  { r += "\\b"; }
            else if (cc === 9)  { r += "\\t"; }
            else if (cc === 10) { r += "\\n"; }
            else if (cc === 12) { r += "\\f"; }
            else if (cc === 13) { r += "\\r"; }
            else if (cc < 32) {
                var h = cc.toString(16);
                r += "\\u" + ("0000" + h).slice(-4);
            } else {
                r += s.charAt(i);
            }
        }
        return r + "\"";
    }

    function str(value) {
        if (value === null) return "null";
        if (value === undefined) return undefined;
        var t = typeof value;
        if (t === "number")  return isFinite(value) ? String(value) : "null";
        if (t === "boolean") return String(value);
        if (t === "string")  return quote(value);
        if (t === "object") {
            var isArr = (value instanceof Array) ||
                        (value && typeof value.length === "number" && typeof value.splice === "function");
            if (isArr) {
                var parts = [];
                for (var i = 0; i < value.length; i++) {
                    var v = str(value[i]);
                    parts.push(v === undefined ? "null" : v);
                }
                return "[" + parts.join(",") + "]";
            }
            var pairs = [];
            for (var k in value) {
                if (value.hasOwnProperty(k)) {
                    var v2 = str(value[k]);
                    if (v2 !== undefined) pairs.push(quote(k) + ":" + v2);
                }
            }
            return "{" + pairs.join(",") + "}";
        }
        return undefined;
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value) {
            var r = str(value);
            return r === undefined ? "null" : r;
        };
    }

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            return eval("(" + String(text) + ")");
        };
    }
})();

// ─── Diagnostic helpers ──────────────────────────────────────────────────────
function pingHost() { return "pong-42"; }
function jsonProbe() {
    if (typeof JSON === "undefined") return "JSON_UNDEFINED";
    if (typeof JSON.stringify !== "function") return "JSON_STRINGIFY_MISSING";
    try {
        var s = JSON.stringify({ a: 1, b: "two", c: [1, 2, "three"] });
        return "JSON_OK:" + s;
    } catch (e) { return "JSON_THROW:" + e.toString(); }
}

// ─── Project info ────────────────────────────────────────────────────────────
function getProjectInfo() {
    try {
        var project = app.project;
        if (!project) return JSON.stringify({ error: "No project is currently open." });
        if (!project.path || project.path === "")
            return JSON.stringify({ error: "Project not saved yet. Save first, then try again." });

        // Phase 1: walk the bin tree. Build:
        //   allBins[]      — every bin: { id, name, path }
        //   nodeIdToBin{}  — nodeId -> { path, id } for every non-bin ProjectItem
        //                    (so sequences can resolve to their bin via
        //                    sequence.projectItem.nodeId — added in PPro 22)
        var allBins = [{ id: "root", name: "All sequences", path: "/" }];
        var nodeIdToBin = {};
        walkBins(project.rootItem, "/", "root", allBins, nodeIdToBin);

        // Phase 2: iterate sequences. Resolve each to its bin via its
        // projectItem. Falls back to root if the lookup misses for any reason.
        var seqList = [];
        var binCounts = {};
        var allSeqs = project.sequences;
        for (var s = 0; s < allSeqs.numSequences; s++) {
            var seq = allSeqs[s];
            var binPath = "/";
            var binId   = "root";

            try {
                if (seq.projectItem) {
                    var pi = seq.projectItem;
                    var resolved = null;
                    try { resolved = nodeIdToBin[pi.nodeId]; } catch (e) {}
                    if (resolved) {
                        binPath = resolved.path;
                        binId   = resolved.id;
                    }
                }
            } catch (e) {}

            seqList.push({
                id:      seq.sequenceID,
                name:    seq.name,
                binId:   binId,
                binPath: binPath
            });

            binCounts[binPath] = (binCounts[binPath] || 0) + 1;
        }

        // Phase 3: roll up bin counts to include descendants; drop empty bins.
        var binList = [];
        for (var i = 0; i < allBins.length; i++) {
            var b = allBins[i];
            var count = binCounts[b.path] || 0;
            for (var j = 0; j < allBins.length; j++) {
                if (i === j) continue;
                if (allBins[j].path.indexOf(b.path) === 0 && allBins[j].path !== b.path) {
                    count += (binCounts[allBins[j].path] || 0);
                }
            }
            if (count > 0 || b.path === "/") {
                b.sequenceCount = count;
                binList.push(b);
            }
        }

        return JSON.stringify({
            path:      project.path,
            name:      project.name,
            bins:      binList,
            sequences: seqList
        });

    } catch (e) {
        return JSON.stringify({ error: "Unexpected error: " + e.toString() });
    }
}

function walkBins(item, binPath, binId, allBins, nodeIdToBin) {
    var children = item.children;
    if (!children) return;

    for (var i = 0; i < children.numItems; i++) {
        var child = children[i];
        var childNodeId = null;
        try { childNodeId = child.nodeId; } catch (e) {}

        if (child.type === ProjectItemType.BIN) {
            var childPath = (binPath === "/") ? ("/" + child.name + "/") : (binPath + child.name + "/");
            var childId   = childNodeId || child.name;
            allBins.push({ id: childId, name: child.name, path: childPath });
            walkBins(child, childPath, childId, allBins, nodeIdToBin);
        } else if (childNodeId !== null) {
            // Non-bin: register so a sequence's projectItem.nodeId can resolve
            // back to this bin location.
            nodeIdToBin[childNodeId] = { path: binPath, id: binId };
        }
    }
}

// ─── Save project ────────────────────────────────────────────────────────────
function saveProject() {
    try {
        app.project.save();
        return JSON.stringify({ success: true });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ─── Check transcript status for a single sequence ──────────────────────────
function checkTranscript(sequenceId) {
    try {
        var seq = findSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ error: "Sequence not found." });

        var entry = extractOneSequence(seq);
        return JSON.stringify({
            id:            sequenceId,
            hasTranscript: !!(entry.text && entry.text.length > 0),
            text:          entry.text || null,
            method:        entry.method
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

// ─── Trigger Speech to Text ─────────────────────────────────────────────────
function triggerTranscription(sequenceId, language) {
    try {
        var lang = language || "en-US";
        var seq  = findSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found." });

        try {
            if (typeof seq.autoTranscribeSequence === "function") {
                seq.autoTranscribeSequence(lang, false, false);
                return JSON.stringify({ success: true, method: "autoTranscribeSequence" });
            }
        } catch (e) {}

        try {
            app.project.activeSequence = seq;
            var cmdIds = [3694, 3560, 3695, 3696];
            for (var i = 0; i < cmdIds.length; i++) {
                try {
                    app.executeMenuCommand(cmdIds[i]);
                    return JSON.stringify({ success: true, method: "menuCommand_" + cmdIds[i] });
                } catch (e2) {}
            }
        } catch (e) {}

        return JSON.stringify({ success: false, error: "autoTranscribeSequence API not available. Run Speech to Text manually in Premiere's Text panel, then export." });

    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ─── Bulk API extraction ─────────────────────────────────────────────────────
function extractTranscriptsForIds(sequenceIdsJson) {
    var out = { results: [] };
    try {
        var ids = JSON.parse(sequenceIdsJson);
        for (var i = 0; i < ids.length; i++) {
            var seq = findSequenceById(ids[i]);
            if (seq) {
                out.results.push(extractOneSequence(seq));
            } else {
                out.results.push({ id: ids[i], text: null, method: "notFound" });
            }
        }
    } catch (e) {
        out.error = e.toString();
    }
    return JSON.stringify(out);
}

// ─── Internal helpers ────────────────────────────────────────────────────────
function findSequenceById(id) {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
        if (seqs[i].sequenceID === id) return seqs[i];
    }
    return null;
}

function extractOneSequence(seq) {
    var entry = { id: seq.sequenceID, name: seq.name, attempts: [] };

    function note(s) { entry.attempts.push(s); }
    function len(v) {
        if (v === null) return "null";
        if (v === undefined) return "undef";
        if (typeof v !== "string") return "type=" + typeof v;
        return "len=" + v.length;
    }

    // ── Promote to active sequence, then restore on the way out ────────────
    // project.sequences[i] returns a thin proxy. The full API surface (where
    // it exists) is only exposed via app.project.activeSequence. We restore
    // the original active sequence so clicking Export doesn't yank the user's
    // timeline to whichever sequence was processed last.
    var act = seq;
    var prevActive = null;
    try { prevActive = app.project.activeSequence; } catch (e) {}
    try {
        app.project.activeSequence = seq;
        act = app.project.activeSequence;
    } catch (e) { note("set activeSequence threw: " + e.toString()); }

    function restoreActive() {
        try { if (prevActive) app.project.activeSequence = prevActive; } catch (e) {}
    }

    // ── Method 1: getText(SeqTextType.TRANSCRIPT_TEXT, srcEnabled) ──
    // Premiere Pro 26+ removed this API from ExtendScript, so the loop just
    // exits quickly when the method doesn't exist. Kept for older versions.
    if (typeof act.getText === "function") {
        var calls = [];
        if (typeof SeqTextType !== "undefined") {
            calls.push(["SeqTextType.TRANSCRIPT_TEXT,false", SeqTextType.TRANSCRIPT_TEXT, false]);
            calls.push(["SeqTextType.TRANSCRIPT_TEXT,true",  SeqTextType.TRANSCRIPT_TEXT, true]);
            calls.push(["SeqTextType.TRANSCRIPT_TEXT",       SeqTextType.TRANSCRIPT_TEXT]);
        }
        for (var n = 0; n < 5; n++) {
            calls.push(["getText(" + n + ",false)", n, false]);
            calls.push(["getText(" + n + ",true)",  n, true]);
            calls.push(["getText(" + n + ")",       n]);
        }
        for (var i = 0; i < calls.length; i++) {
            var cs = calls[i];
            try {
                var raw = (cs.length === 2) ? act.getText(cs[1]) : act.getText(cs[1], cs[2]);
                if (typeof raw === "string" && raw.length > 20) {
                    entry.text = raw; entry.method = cs[0];
                    restoreActive();
                    return entry;
                }
            } catch (e) {}
        }
        note("getText exists but all call shapes rejected/empty");
    } else {
        note("act.getText not a function");
    }

    // ── Method 2: captionTracks (older Premiere builds) ──
    try {
        var ctList = null;
        if (typeof act.getCaptionTracks === "function") ctList = act.getCaptionTracks();
        else if (act.captionTracks) ctList = act.captionTracks;
        if (ctList) {
            var nt = ctList.numTracks !== undefined ? ctList.numTracks : ctList.length;
            var lines = [];
            for (var t = 0; t < nt; t++) {
                var ct = ctList[t];
                if (!ct) continue;
                var clips = ct.clips || ct.captions;
                if (!clips) continue;
                var nClips = clips.numItems !== undefined ? clips.numItems : clips.length;
                for (var c = 0; c < nClips; c++) {
                    var clip = clips[c];
                    try {
                        var txt = clip.captionText || clip.text || (typeof clip.getText === "function" && clip.getText()) || "";
                        if (txt && txt.length > 0) lines.push(txt);
                    } catch (e) {}
                }
            }
            if (lines.length > 0) {
                entry.text = lines.join(" "); entry.method = "captionTracks";
                restoreActive();
                return entry;
            }
        }
    } catch (e) { note("captionTracks threw: " + e.toString()); }

    // ── Method 3: markers (some workflows put transcripts here) ──
    try {
        var markerText = readTranscriptMarkers(act);
        if (markerText && markerText.length > 50) {
            entry.text = markerText; entry.method = "markers";
            restoreActive();
            return entry;
        }
    } catch (e) {}

    // No method worked. .prproj file parsing on the panel side is the
    // primary path for Premiere 26+ where ExtendScript can't reach transcripts.
    note("no in-engine transcript path available; falling through to .prproj parse");
    entry.text   = null;
    entry.method = "none";
    restoreActive();
    return entry;
}

function readTranscriptMarkers(seq) {
    if (!seq || !seq.markers) return "";
    var text = [];
    var markers = seq.markers;
    var n = markers.numMarkers || 0;
    for (var i = 0; i < n; i++) {
        var m = markers[i];
        if (m && m.comments && m.comments.length > 0) text.push(m.comments);
    }
    return text.join(" ");
}
