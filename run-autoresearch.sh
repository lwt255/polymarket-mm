#!/bin/bash
# Autoresearch overnight runner

cd /Users/levanielthompson/Documents/Projects/polymarket-mm

# Clean up any leftover experiment branches
git checkout main 2>/dev/null
for branch in $(git branch --list 'autoresearch-*'); do
    git branch -D "$branch" 2>/dev/null
done

# Keep Mac awake during the run
caffeinate -i -w $$ &

LOG_FILE="logs/autoresearch-$(date +%Y%m%d-%H%M%S).log"
mkdir -p logs

echo "Starting autoresearch at $(date)" | tee "$LOG_FILE"

# Use script(1) to force unbuffered output so logs are visible in real-time
# NODE_OPTIONS disables output buffering in Node
export NODE_NO_WARNINGS=1
nohup npx tsx src/scripts/autoresearch/loop.ts \
    --iterations 10 \
    --duration 60 \
    --reset-history \
    >> "$LOG_FILE" 2>&1 &

echo "PID: $!" | tee -a "$LOG_FILE"
echo "Log: $LOG_FILE"
