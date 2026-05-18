from pathlib import Path
text = Path('/home/ubuntu/subagent_research/targeted_subagent_grep.txt').read_text(errors='ignore').splitlines()
cur = None
summary = []
for line in text:
    if line.startswith('## '):
        cur = line[3:]
        summary.append((cur, []))
    elif cur and line.strip():
        low = line.lower()
        if len(line) > 1000 or any(skip in low for skip in ['index.html','tree-sitter','leaderboard_table','package-lock','pnpm-lock','yarn.lock','cargo.lock','poetry.lock','uv.lock','.svg']):
            continue
        if any(term in low for term in ['subagent','sub-agent','sub agent','runsubagent','delegatetool','handoff','supervisor','swarm','as_tool','agent as tool','spawn']):
            summary[-1][1].append(line[:300])
with Path('/home/ubuntu/subagent_research/filtered_grep_summary.md').open('w') as f:
    for repo, lines in summary:
        f.write(f'## {repo} ({len(lines)} relevant)\n\n')
        for line in lines[:50]:
            f.write(f'- `{line}`\n')
        f.write('\n')
