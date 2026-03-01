# Scenario: Overnight Stability

## User Story
Peter leaves Argus running overnight. In the morning, he checks that everything is still working — cameras stream, recordings exist, no crashes.

## Steps
1. Argus running with 1+ cameras for 12+ hours
2. Check: process still running (no crash)
3. Check: recordings exist for the full period
4. Check: no recording gaps > 5 minutes (unless camera was truly offline)
5. Check: memory usage hasn't grown significantly (no leak)
6. Check: live stream still works from Home app
7. Check: disk usage is within expected bounds

## Satisfaction Criteria
- Process uptime > 12 hours without restart
- Recording segments cover the full period
- Memory usage < 500MB (for 2 cameras)
- CPU usage < 15% average (for 2 cameras, excluding transcoding)
- Home app live stream loads successfully
- SQLite DB is not corrupted
