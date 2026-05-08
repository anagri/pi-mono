---
description: Compute how many days the user has been alive given a YYYY-MM-DD birthday
argument-hint: <YYYY-MM-DD>
---
You have a JavaScript helper at `./script.js` (relative to the skill's location given above). To compute the age in days, call the `run_script` tool with:

- `path`: the absolute path to `script.js` in this skill's folder (use the location field above and replace `SKILL.md` with `script.js`)
- `args`: `["<YYYY-MM-DD>"]` — the birthday the user supplied

The script writes a single integer (the number of days between the birthday and today) to stdout. After receiving the result, reply to the user in plain English along the lines of: "You are <N> days old." Do not include any other commentary.
