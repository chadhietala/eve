---
"eve": patch
---

Add `eve/self-improvement`: agents that learn operating rules from experience and adopt them. `selfImprovement()` proposes directives from corrections and repeated failures, `learnedDirectives()` contributes the active ones to the agent's instructions at session start, and `renderAgentPatch()` writes them into `agent/instructions/learned.md` so the change can be reviewed and committed. Activation requires human approval by default.
