#!/bin/bash
# Autoresearch overnight runner
# Scheduled to start at 3:10 AM ET after Max plan token reset

cd /Users/levanielthompson/Documents/Projects/polymarket-mm

# Clean up any leftover experiment branches
git checkout main 2>/dev/null
for branch in $(git branch --list 'autoresearch-*'); do
    git branch -D "$branch" 2>/dev/null
done

# Keep Mac awake during the run
caffeinate -i -w $$ &

# Run the loop: 10 iterations × 60 min each = ~10 hours
LOG_FILE="logs/autoresearch-$(date +%Y%m%d-%H%M%S).log"
mkdir -p logs

echo "Starting autoresearch at $(date)" | tee "$LOG_FILE"
nohup npx tsx src/scripts/autoresearch/loop.ts \
    --iterations 10 \
    --duration 60 \
    --reset-history \
    >> "$LOG_FILE" 2>&1 &

echo "PID: $!" | tee -a "$LOG_FILE"
echo "Log: $LOG_FILE"
