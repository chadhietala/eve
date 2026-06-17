---
"eve": patch
---

Add step-scoped credential brokering to the Vercel Sandbox backend, including interactive per-user authorization. Sandboxes remain on an empty-token policy while authorization is pending, then receive the credentialed policy on the resumed step.
