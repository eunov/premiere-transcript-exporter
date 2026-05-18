#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Transcript Exporter — installer for macOS
#
# What this does:
#   1. Copies the extension into your CEP extensions folder.
#   2. Enables unsigned CEP extensions (required; see note below).
#   3. Prompts you to restart Premiere Pro.
#
# IMPORTANT — unsigned extension flag:
#   Adobe CEP requires extensions to be digitally signed for production use.
#   This script sets the "PlayerDebugMode" flag so that Adobe host apps accept
#   unsigned/locally-installed extensions. This is standard practice for
#   in-house / team tools that are not distributed via the Exchange.
#
# Usage:
#   chmod +x install.sh
#   ./install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

EXTENSION_ID="com.acquisition.transcriptexporter"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXTENSION_ID"

echo ""
echo "=== Transcript Exporter Installer ==="
echo ""

# ── 1. Copy extension files ───────────────────────────────────────────────────
echo "Installing to:"
echo "  $DEST"
echo ""

if [ -d "$DEST" ]; then
  echo "Removing previous installation…"
  rm -rf "$DEST"
fi

mkdir -p "$DEST"
cp -R "$SCRIPT_DIR/CSXS"   "$DEST/"
cp -R "$SCRIPT_DIR/host"   "$DEST/"
cp -R "$SCRIPT_DIR/client" "$DEST/"

echo "Files copied."
echo ""

# ── 2. Enable unsigned extensions ─────────────────────────────────────────────
# PlayerDebugMode must be set for the CSXS runtime version your host app uses.
# Premiere 2025/2026 ships CEP 12 (CSXS.12). Earlier Premiere versions used
# CSXS.11/10/9. Setting all of them covers Premiere 2019 → 2026.
echo "Enabling unsigned CEP extensions (PlayerDebugMode)…"
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.9  PlayerDebugMode 1
echo "Done."
echo ""

# ── 3. Done ───────────────────────────────────────────────────────────────────
echo "✓ Installation complete."
echo ""
echo "Next steps:"
echo "  1. Quit Premiere Pro if it is running."
echo "  2. Reopen Premiere Pro."
echo "  3. Go to Window > Extensions > Transcript Exporter."
echo ""
