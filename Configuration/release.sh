#!/bin/bash

# Script to extract version and release information from Release_Notes.md
# This is used by the GitHub Actions workflow

set -e

# Extract latest version (first line that starts with #)
LATEST_VERSION=$(grep -m 1 '^# ' Release_Notes.md | sed 's/^# \([0-9.]*\) - .*/\1/')
LATEST_TITLE=$(grep -m 1 '^# ' Release_Notes.md | sed 's/^# [0-9.]* - \(.*\)/\1/')

# Extract release notes for the latest version
RELEASE_NOTES=$(awk '/^# [0-9.]*/{if(NR>1)exit} NR>1' Release_Notes.md | sed '/^$/d' | head -n -1)

# Extract previous version (second line that starts with #)
PREVIOUS_VERSION=$(grep '^# ' Release_Notes.md | sed -n '2p' | sed 's/^# \([0-9.]*\) - .*/\1/')

echo "Latest Version: $LATEST_VERSION"
echo "Latest Title: $LATEST_TITLE"
echo "Previous Version: $PREVIOUS_VERSION"
echo "Release Notes:"
echo "$RELEASE_NOTES"
