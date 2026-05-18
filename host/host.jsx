/**
 * Transcript Exporter — ExtendScript host
 * Runs inside Premiere Pro's scripting engine.
 */

// ─── Project info ─────────────────────────────────────────────────────────────

function getProjectInfo() {
    try {
        var project = app.project;
        if (!project) return JSON.stringify({ error: "No project is currently open." });
        if (!project.path || project.path === "")
            return JSON.stringify({ error: "Project not saved yet. Save first, then try again." });

        // Walk the bin tree, collecting sequences and their bin locations
        var binList   = [];   // [{ id, name, path, sequenceCount }]
        var seqList   = [];   // [{ id, name, binId, binPath }]
        var seqIds    = {};   // quick lookup: sequenceID -> true

        // Build a set of valid sequence IDs
        var allSeqs = project.sequences;
        for (var s = 0; s < allSeqs.numSequences; s++) {
            seqIds[allSeqs[s].sequenceID] = true;
        }

        // Recursive bin walker
        walkBin(project.rootItem, "/", "", binList, seqList, seqIds);

        return JSON.stringify({
            path:     project.path,
            name:     project.name,
            bins:     binList,
            sequences: seqList
        });

    } catch (e) {
        return JSON.stringify({ error: "Unexpected error: " + e.toString() });
    }
}

/**
 * Recursively walks a bin (ProjectItem of type BIN).
 * Populates binList and seqList in place.
 */
function walkBin(bin, binPath, binId, binList, seqList, seqIds) {
    var children = bin.children;
    if (!children) return;

    var localSeqCount = 0;

    for (var i = 0; i < children.numItems; i++) {
        var child = children[i];

        // Type 2 = BIN
        if (child.type === ProjectItemType.BIN) {
            var childPath = (binPath === "/") ? ("/" + child.name + "/") : (binPath + child.name + "/");
            var childId   = child.nodeId || child.name; // nodeId not always available
            walkBin(child, childPath, childId, binList, seqList, seqIds);
        }

        // Type 1 = CLIP (sequences appear as clips in the project panel)
        if (child.type === ProjectItemType.CLIP || child.type === 1) {
            // Check if this project item corresponds to a sequence
            try {
                // getMediaPath() is empty for sequences; use the sequence lookup
                // A sequence's projectItem matches when its nodeId aligns
                var nodeId = child.nodeId;
                if (seqIds[nodeId]) {
                    seqList.push({
                        id:      nodeId,
                        name:    child.name,
                        binId:   binId || "root",
                        binPath: binPath
                    });
                    localSeqCount++;
                }
            } catch (e) {}
        }
    }

    // Register this bin only if it (or its descendants) hold sequences
    var childBinSeqCount = 0;
    for (var b = 0; b < binList.length; b++) {
        if (binList[b].path.indexOf(binPath) === 0 && binList[b].path !== binPath) {
            childBinSeqCount += binList[b].sequenceCount;
        }
    }
    var totalCount = localSeqCount + childBinSeqCount;

    if (totalCount > 0 || binPath === "/") {
        binList.push({
            id:            binId || "root",
            name:          (binPath === "/") ? "All sequences" : bin.name,
            path:          binPath,
            sequenceCount: totalCount
        });
    }
}

// ─── Save project ─────────────────────────────────────────────────────────────

function saveProject() {
    try {
        app.project.save();
        return JSON.stringify({ success: true });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ─── Check transcript status for a single sequence ───────────────────────────

/**
 * Returns { id, hasTranscript, text } for the given sequenceId.
 * "hasTranscript" is true if any text was found via the scripting API.
 */
function checkTranscript(sequenceId) {
    try {
        var seq = findSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ error: "Sequence not found." });

        var entry = extractOneSequence(seq);
        return JSON.stringify({
            id:          sequenceId,
            hasTranscript: !!(entry.text && entry.text.trim().length > 0),
            text:        entry.text || null,
            method:      entry.method
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

// ─── Trigger Speech to Text transcription ────────────────────────────────────

/**
 * Starts Premiere Pro's Speech to Text on the given sequence.
 *
 * Premiere Pro 22.0+ added sequence.autoTranscribeSequence().
 * The method is asynchronous — it starts transcription in the background.
 * The panel polls checkTranscript() to detect completion.
 *
 * @param {string} sequenceId
 * @param {string} language  BCP-47 code, e.g. "en-US"
 */
function triggerTranscription(sequenceId, language) {
    try {
        var lang = language || "en-US";
        var seq  = findSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found." });

        // ── Method A: autoTranscribeSequence (Premiere 22.0+) ─────────────────
        try {
            if (typeof seq.autoTranscribeSequence === "function") {
                // Params: language (string), fillGaps (bool), exportSD (bool)
                seq.autoTranscribeSequence(lang, false, false);
                return JSON.stringify({ success: true, method: "autoTranscribeSequence" });
            }
        } catch (e) { /* fall through */ }

        // ── Method B: activate sequence + menu command ────────────────────────
        // Menu command IDs for "Transcribe Sequence" in Premiere Pro.
        // These IDs vary by version; we try a known range.
        try {
            app.project.activeSequence = seq;
            var cmdIds = [3694, 3560, 3695, 3696]; // known candidates
            for (var i = 0; i < cmdIds.length; i++) {
                try {
                    app.executeMenuCommand(cmdIds[i]);
                    return JSON.stringify({ success: true, method: "menuCommand_" + cmdIds[i] });
                } catch (e2) { /* try next */ }
            }
        } catch (e) { /* fall through */ }

        return JSON.stringify({ success: false, error: "autoTranscribeSequence API not available. Run Speech to Text manually in Premiere's Text panel, then export." });

    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ─── Bulk API extraction ──────────────────────────────────────────────────────

/**
 * Attempts to extract transcript text for a list of sequence IDs via the
 * Premiere scripting API.
 *
 * @param {string} sequenceIdsJson  JSON array of sequence ID strings
 */
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function findSequenceById(id) {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
        if (seqs[i].sequenceID === id) return seqs[i];
    }
    return null;
}

function extractOneSequence(seq) {
    var entry = { id: seq.sequenceID, name: seq.name };

    // Method A: sequence.getText() — Premiere Pro 23.3+
    try {
        if (typeof seq.getText === "function") {
            var raw = seq.getText(SeqTextType.TRANSCRIPT_TEXT);
            if (raw && raw.trim().length > 0) {
                entry.text   = raw;
                entry.method = "getText";
                return entry;
            }
        }
    } catch (e) {}

    // Method B: iterate caption clips on video tracks
    try {
        var captionText = readCaptionTracks(seq);
        if (captionText) {
            entry.text   = captionText;
            entry.method = "captionTrack";
            return entry;
        }
    } catch (e) {}

    // Method C: sequence markers
    try {
        var markerText = readTranscriptMarkers(seq);
        if (markerText) {
            entry.text   = markerText;
            entry.method = "markers";
            return entry;
        }
    } catch (e) {}

    entry.text   = null;
    entry.method = "none";
    return entry;
}

function readCaptionTracks(seq) {
    var lines = [];
    var videoTracks = seq.videoTracks;
    for (var t = 0; t < videoTracks.numTracks; t++) {
        var track = videoTracks[t];
        var clips  = track.clips;
        for (var c = 0; c < clips.numItems; c++) {
            var clip = clips[c];
            try {
                if (clip.captionText && clip.captionText.length > 0) {
                    lines.push(clip.captionText);
                    continue;
                }
            } catch (e) {}
            try {
                var nm = clip.name || "";
                if (nm.length > 0 && nm.length < 300 && nm.indexOf(".") === -1) {
                    lines.push(nm);
                }
            } catch (e) {}
        }
    }
    return lines.join(" ").trim();
}

function readTranscriptMarkers(seq) {
    var text = [];
    var markers = seq.markers;
    for (var i = 0; i < markers.numMarkers; i++) {
        var m = markers[i];
        if (m.comments && m.comments.length > 0) text.push(m.comments);
    }
    return text.join(" ").trim();
}
