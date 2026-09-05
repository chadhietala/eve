---
"eve": patch
---

Add built-in computer use. `eve/tools/computer` gives an agent one tool to see a screen and drive a mouse and keyboard, and `eve/computer` supplies the backends behind it: `virtualComputer()` for tests and evals, `systemComputer()` for the machine eve runs on, and `remoteComputer()` plus `createComputerHost()` for driving another machine over an authenticated protocol.
