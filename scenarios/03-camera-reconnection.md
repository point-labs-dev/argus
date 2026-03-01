# Scenario: Camera Goes Offline and Recovers

## User Story
Peter's camera loses power during a storm. 30 minutes later, power returns. He expects Argus to recover automatically without intervention.

## Steps
1. Argus running normally with camera streaming
2. Camera goes offline (network unreachable)
3. Home app shows camera as "Not Responding" within 60 seconds
4. Recording stops, gap logged in SQLite
5. Camera comes back online
6. Argus reconnects automatically
7. Recording resumes
8. Home app shows camera as available again
9. Live stream works

## Satisfaction Criteria
- Camera offline detected within 60 seconds
- No crash or unhandled exception during offline period
- Reconnection happens within 2 minutes of camera returning
- Recording gap is accurately tracked (start/end times in SQLite)
- No manual intervention required
- Resource usage doesn't spike during reconnection attempts
