# Transcript Exporter for Adobe Premiere Pro

I got sick of exporting Premiere transcripts one sequence at a time. I wanted a way to batch-export a whole project at once and keep the text on my drive for things like learning, branding, tone of voice work, and repurposing.

This is a small Premiere Pro panel that does exactly that. Open it, click one button, and every sequence in your project gets its Speech to Text transcript written to a `.txt` file inside a `transcripts/` folder next to your `.prproj`.

## Requirements

You'll need Premiere Pro 2022 (v22.0) or later, since that's when Speech to Text shipped. The install script in this repo is written for macOS; Windows users can install by hand using the steps further down. And each sequence has to have already had Speech to Text run on it (Text panel, then the Transcript tab) before the panel can export anything from it.

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

There are three different ways to get transcript text out of Premiere, and the panel tries them in order. First it asks the scripting API directly using `sequence.getText()`, which works on Premiere Pro 23.3 and up. If that comes back empty, it walks each sequence's video tracks looking for caption clips and reads the text off of those. If both of those still give nothing, it falls back to decompressing the `.prproj` file itself and scanning the XML inside for caption and transcript nodes. That last path is what catches data even when the scripting API doesn't surface it.

## Troubleshooting

**The panel doesn't show up in Window > Extensions.** First check that the install script actually finished without errors. Then confirm `PlayerDebugMode` is set by running `defaults read com.adobe.CSXS.11 PlayerDebugMode` in Terminal. If both of those check out, quit Premiere and reopen it.

**Every sequence shows up as "no transcript."** Open the Text panel inside Premiere (Window > Text), pick a sequence, and look at the Transcript tab. If it's blank, you need to click Transcribe and let Speech to Text actually run before the exporter has anything to grab.

**The transcript text looks garbled.** Usually this means the project file is large and the parser is reading an older saved copy. Hit the ↻ Refresh button in the panel and export again. The plugin saves the project before parsing, so a refresh clears up most of these cases.
