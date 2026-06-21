---
"eve": patch
---

Fire memory consolidation ("dream") automatically. When an agent's memory
declares `dream.schedule.idleMs`, a durable per-agent timer is re-armed at each
active step so it slides while the user is engaged and fires once they've gone
idle; a cron backstop sweeps any due timers and runs the consolidation. The
dream's session floor is honored via `dream.schedule.minSessions`.
