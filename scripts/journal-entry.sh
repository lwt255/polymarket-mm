#!/bin/bash
# Journal entry helper for Polymarket-MM
# Usage: ./scripts/journal-entry.sh [command] [args]

JOURNAL_DIR="journal"
TEMPLATE="$JOURNAL_DIR/TEMPLATE.md"
TODAY=$(date +%Y-%m-%d)
TODAY_FILE="$JOURNAL_DIR/$TODAY.md"
TODAY_DISPLAY=$(date +"%B %d, %Y")

# Ensure we're in the project root
cd "$(dirname "$0")/.." || exit 1

case "$1" in
  new)
    # Create today's journal from template
    if [ -f "$TODAY_FILE" ]; then
      echo "Journal for $TODAY already exists: $TODAY_FILE"
      exit 1
    fi
    
    if [ ! -f "$TEMPLATE" ]; then
      echo "Template not found: $TEMPLATE"
      exit 1
    fi
    
    # Replace [DATE] with today's date
    sed "s/\[DATE\]/$TODAY_DISPLAY/" "$TEMPLATE" > "$TODAY_FILE"
    echo "✅ Created journal: $TODAY_FILE"
    ;;
    
  add)
    # Add a new session entry with timestamp
    if [ -z "$2" ]; then
      echo "Usage: $0 add \"Activity Title\""
      exit 1
    fi
    
    # Create journal if it doesn't exist
    if [ ! -f "$TODAY_FILE" ]; then
      sed "s/\[DATE\]/$TODAY_DISPLAY/" "$TEMPLATE" > "$TODAY_FILE"
      echo "✅ Created journal: $TODAY_FILE"
    fi
    
    TIME=$(date +"%I:%M %p")
    TITLE="$2"
    
    # Add entry after Session Log section
    cat << EOF >> "$TODAY_FILE"

### $TIME - $TITLE
**Activity**: [Description]

**What I Did**:
1. [Action item 1]

**Insights**:
- [Key insight]

**Next Steps**:
- [Action item]

---
EOF
    echo "✅ Added session entry: $TIME - $TITLE"
    ;;
    
  open)
    # Open today's journal in default editor
    if [ ! -f "$TODAY_FILE" ]; then
      echo "No journal for today. Run '$0 new' first."
      exit 1
    fi
    
    if [ -n "$EDITOR" ]; then
      $EDITOR "$TODAY_FILE"
    elif command -v code &> /dev/null; then
      code "$TODAY_FILE"
    elif command -v nano &> /dev/null; then
      nano "$TODAY_FILE"
    else
      cat "$TODAY_FILE"
    fi
    ;;
    
  commits)
    # Show recent commits
    echo "📝 Recent commits:"
    git log --oneline -10
    ;;
    
  *)
    echo "Polymarket-MM Journal Helper"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  new              Create today's journal from template"
    echo "  add \"Title\"      Add a new session entry"
    echo "  open             Open today's journal in editor"
    echo "  commits          Show recent git commits"
    echo ""
    echo "Today's journal: $TODAY_FILE"
    ;;
esac
