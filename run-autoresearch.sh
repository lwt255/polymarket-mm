#!/bin/bash
# Autoresearch overnight runner

cd /Users/levanielthompson/Documents/Projects/polymarket-mm

# Clean up any leftover experiment branches
git checkout main 2>/dev/null
for branch in $(git branch --list 'autoresearch-*'); do
    git branch -D "$branch" 2>/dev/null
done

LOG_FILE="logs/autoresearch-$(date +%Y%m%d-%H%M%S).log"
mkdir -p logs

echo "Starting autoresearch at $(date)" | tee "$LOG_FILE"

# Keep Mac awake (prevent sleep, display sleep, and idle sleep)
caffeinate -s -i -d -w $$ &
CAFE_PID=$!
trap "kill $CAFE_PID 2>/dev/null" EXIT

export NODE_NO_WARNINGS=1
nohup npx tsx src/scripts/autoresearch/loop.ts \
    --iterations 20 \
    --duration 30 \
    --reset-history \
    >> "$LOG_FILE" 2>&1 &

BOT_PID=$!
echo "PID: $BOT_PID" | tee -a "$LOG_FILE"
echo "Log: $LOG_FILE"
echo "Caffeinate PID: $CAFE_PID"
echo ""
echo "Monitor with: tail -f $LOG_FILE"
