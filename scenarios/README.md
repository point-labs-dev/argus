# Scenarios (Holdout Verification)

End-to-end user scenarios stored OUTSIDE the codebase context given to coding agents.

Like holdout sets in ML training — agents can't see these during implementation, preventing them from coding to the test. These are used by the orchestrator (Ceph) to verify the agent's work.

## How It Works

1. Human writes scenarios describing real user journeys
2. Coding agent implements against SPEC.md (never sees scenarios/)
3. After agent claims "done," orchestrator runs scenarios against the build
4. Satisfaction scoring: "Of all observed trajectories, what fraction satisfy the user?"
5. If scenarios fail → learnings go to progress/ → agent tries again with fresh context
