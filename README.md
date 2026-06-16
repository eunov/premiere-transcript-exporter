# Transcript Exporter for Adobe Premiere Pro

I got sick of exporting Premiere transcripts one sequence at a time. I wanted a way to batch-export a whole project at once and keep the text on my drive for things like learning, branding, tone of voice work, and repurposing.

This is a small Premiere Pro panel that does exactly that. Open it, click one button, and every sequence in your project gets its Speech to Text transcript written to a `.txt` file inside a `transcripts/` folder next to your `.prproj`.

## Requirements

You'll need Premiere Pro 2022 (v22.0) or later, since that's when Speech to Text shipped. The install script in this repo is written for macOS; Windows users can install by hand using the steps further down. The footage your sequences are built from has to have had Speech to Text run on it (Text panel, then the Transcript tab) — the panel reads that transcript and gives each sequence just its own portion. If a clip is cut from a recording that was never transcribed, there's nothing to export for it.

## Install on macOS

From the repo root:

```bash
chmod +x install.sh
./install.sh
```

Quit Premiere if it's open, then reopen it. You'll find the panel under **Window > Extensions > Transcript Exporter**.

## Install on Windows

Copy the `com.acquisition.transcriptexporter` folder into:

```
%APPDATA%\Adobe\CEP\extensions\com.acquisition.transcriptexporter\
```

Then open `regedit` and enable unsigned extensions. Navigate to `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.12` for Premiere 2025 and 2026, and add a String value called `PlayerDebugMode` set to `1`. If you need older versions to work too, do the same thing under `CSXS.11`, `CSXS.10`, and `CSXS.9`. Restart Premiere after.

## How to use it

Open a Premiere project, make sure Speech to Text has been run on the sequences you care about, then open the panel from **Window > Extensions > Transcript Exporter** and click **Export All Transcripts**. The files land in `[your-project-folder]/transcripts/[Sequence Name].txt`.

As the export runs, each sequence gets a colored dot next to its name. Green means the transcript was exported. Yellow means there was nothing to export, usually because Speech to Text was never run on that sequence. Red means something went wrong writing the file.

## How it pulls the transcripts

On older Premiere the panel first asks the scripting API for a whole-sequence transcript (`sequence.getText()`). Premiere Pro 26 removed that API, so the panel's main path is different: it reads the Speech to Text transcript out of the `.prproj` file *with word-level timings*, then asks Premiere for each sequence's clip in/out points and slices the transcript down to just the words inside each clip.

This is what makes podcast-style projects work. When many short clips are cut from one long recording, there is only one transcript (the recording's) — not a separate transcript per clip. Older versions of this panel tried to guess which whole transcript belonged to which clip by name and got it wrong: a 60-second clip would come out with the entire podcast, or with nothing. Slicing by the clip's actual in/out point gives each sequence exactly its own words.

A sequence exports if (a) its clips are linked to source footage that has a transcript, and (b) Premiere reports the clip in/out points. If a sequence comes back empty, `transcripts/_diagnostic.txt` shows the window it tried to slice and why it found no words.

## Troubleshooting

**The panel doesn't show up in Window > Extensions.** First check that the install script actually finished without errors. Then confirm `PlayerDebugMode` is set by running `defaults read com.adobe.CSXS.11 PlayerDebugMode` in Terminal. If both of those check out, quit Premiere and reopen it.

**Every sequence shows up as "no transcript."** Open the Text panel inside Premiere (Window > Text), select the source footage the clips were cut from, and look at the Transcript tab. If it's blank, click Transcribe and let Speech to Text run — the panel slices that transcript, so the source has to have one.

**A clip exported the wrong part of the recording.** Open `transcripts/_diagnostic.txt`. It lists, per sequence, the in/out window (in seconds) it sliced. If a window is off, the clip's source in/out points in Premiere are what drive it — confirm the clip is a straight trim of the transcribed recording.

**The transcript text looks garbled or stale.** Usually the project file is large and an older saved copy is being read. Hit the ↻ Refresh button and export again. The panel saves the project before parsing, which clears up most of these.
