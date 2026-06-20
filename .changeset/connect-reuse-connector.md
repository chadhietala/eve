---
"eve": patch
---

Connect-backed connections now prefer a compatible Vercel Connect connector already attached to the project, reuse a compatible team connector after an explicit choice, and create one only when needed. Creating one prompts for its name and suggests the next available name instead of assuming the connection slug is unused. Connector reuse checks the subject modes supported by each connector, preventing a user-scoped connection from reusing a legacy connector that cannot authorize users. `/connect` installs dependencies before writing or patching the connection file, so failed installs remain retryable, and reports the provider's actual setup error when connector creation fails. End users authorize separately on first use.
