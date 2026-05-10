---
description: Compute days between a YYYY-MM-DD birthday and the baseline date 2026-05-08.
---
A JavaScript helper named `script.js` lives next to this SKILL.md. The
`<skill location="...">` wrapper above gives you the absolute path to this
SKILL.md — drop the trailing `/SKILL.md` and append `/script.js` to get the
helper's absolute path.

Call the run_script tool with:

- `path`: the absolute path to that script.js
- `args`: `["<YYYY-MM-DD>"]` where the date comes from the user's message

The script prints a single integer (number of days between the supplied
date and 2026-05-08) to stdout. Reply with exactly that integer and
nothing else.
