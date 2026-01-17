#!/bin/bash
# Create daily journal from template
# Run via cron or systemd timer at midnight

JOURNAL_DIR="journal"
TEMPLATE="$JOURNAL_DIR/TEMPLATE.md"
TODAY=$(date +%Y-%m-%d)
TODAY_FILE="$JOURNAL_DIR/$TODAY.md"
TODAY_DISPLAY=$(date +"%B %d, %Y")

# Ensure we're in the project root
cd "$(dirname "$0")/.." || exit 1

# Skip if already exists
if [ -f "$TODAY_FILE" ]; then
  echo "Journal for $TODAY already exists"
  exit 0
fi

# Create from template
if [ -f "$TEMPLATE" ]; then
  sed "s/\[DATE\]/$TODAY_DISPLAY/" "$TEMPLATE" > "$TODAY_FILE"
  echo "Created journal: $TODAY_FILE"
else
  echo "Template not found: $TEMPLATE"
  exit 1
fi
