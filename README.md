# Transcript Exporter for Adobe Premiere Pro

A CEP panel that exports the Speech to Text transcript for every sequence in the open project into plain `.txt` files — so the content pipeline always has fresh transcripts without any manual work.

---

## Requirements

- **Premiere Pro 2022 (v22.0) or later** — Speech to Text was introduced in this version.
- **macOS** — the install script targets Mac. For Windows, see manual install below.
- Sequences must have had **Speech to Text** run on them (Text panel > Transcript tab) before exporting.

---

## Install (macOS — one time)

```bash
chmod +x install.sh
./install.sh
```

Then:
1. Quit Premiere Pro if open.
2. Reopen Premiere Pro.
3. **Window > Extensions > Transcript Exporter**

---

## Install (Windows — manual)

1. Copy the entire `com.acquisition.transcriptexporter` folder to:
   ```
   %APPDATA%\Adobe\CEP\extensions\com.acquisition.transcriptexporter\
   ```
2. Enable unsigned extensions in the registry:
   - Open `regedit`
   - Navigate to `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12` (Premiere 2025/2026)
   - Add a String value: `PlayerDebugMode` = `1`
   - Repeat for `CSXS.11`, `CSXS.10`, and `CSXS.9` if those keys exist (for older Premiere versions).
3. Restart Premiere Pro.

---

## How to use

1. Open a Premiere Pro project.
2. Make sure Speech to Text has been run on your sequences (Text panel > Transcript tab).
3. Open the panel: **Window > Extensions > Transcript Exporter**.
4. Click **Export All Transcripts**.

Transcript files are saved to:
```
[same folder as your .prproj file]/transcripts/[Sequence Name].txt
```

The panel shows a colored dot for each sequence:
- **Green** — transcript exported successfully.
- **Yellow** — no transcript found (Speech to Text not yet run on this sequence).
- **Red** — file write error.

---

## How transcript extraction works

The plugin uses three methods in order, falling back to the next if the previous yields nothing:

1. **Premiere scripting API** (`sequence.getText()`) — works in Premiere Pro 23.3+.
2. **Caption track scan** — walks each sequence's video tracks for caption clip text.
3. **Project file parser** — decompresses the `.prproj` file and searches the XML for caption/transcript nodes. This catches data even when the scripting API doesn't expose it.

---

## Connecting to the content pipeline

The `transcripts/` folder sits next to every `.prproj` file. Point the content pipeline's watch folder at the parent directory (or at each project's `transcripts/` subfolder) and it will pick up new `.txt` files automatically whenever you run an export.

---

## Troubleshooting

**Panel doesn't appear in Window > Extensions**
- Confirm the install script ran without errors.
- Confirm `PlayerDebugMode 1` is set (run `defaults read com.adobe.CSXS.11 PlayerDebugMode`).
- Restart Premiere Pro completely.

**All sequences show "no transcript"**
- Open the Text panel in Premiere (Window > Text), select the sequence, and check the Transcript tab. If it's empty, click "Transcribe" to run Speech to Text first.

**Transcript text looks garbled**
- This can happen if the project file is very large and the parser is reading a stale save. Click "↻ Refresh" and then export again — the plugin saves the project before parsing.
