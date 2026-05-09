---
description: Compute days between a YYYY-MM-DD birthday and the baseline date.
disable-model-invocation: true
---
You have a JavaScript helper at .bodhi-pi/skills/days-since-birthday/script.js (relative to the workspace cwd).
Call run_script with:

- path: ".bodhi-pi/skills/days-since-birthday/script.js"
- args: ["<YYYY-MM-DD>"] where the date comes from the user's message.

Reply with exactly that integer and nothing else.
