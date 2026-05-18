import json
import subprocess
from pathlib import Path

base = Path('/home/ubuntu/subagent_research')
clone_root = base/'repos'
repos = sorted([p for p in clone_root.iterdir() if p.is_dir() and (p/'.git').exists()])
regex = r'sub-?agent|sub agent|delegate|delegation|handoff|supervisor|swarm|multi.agent|as_tool|agent.*tool|spawn.*agent|child agent|runSubagent|DelegateTool|TaskTool'
results = []
for dest in repos:
    repo = dest.name.replace('__','/')
    matches = []
    try:
        cmd = ['git','-C',str(dest),'grep','-n','-I','-i','-E', regex]
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90)
        for line in p.stdout.splitlines():
            parts = line.split(':',2)
            if len(parts) != 3:
                continue
            file, lineno, text = parts
            lf = file.lower()
            if any(skip in lf for skip in ['package-lock','pnpm-lock','yarn.lock','uv.lock','poetry.lock','cargo.lock','changelog','readme_zh','readme-cn','.svg','.jsonl','.snap']):
                continue
            if len(matches) < 250:
                matches.append({'file': file, 'line': int(lineno) if lineno.isdigit() else None, 'text': text.strip()[:300]})
    except Exception as e:
        matches.append({'file':'','line':None,'text':f'grep failed: {e}'})
    lower = '\n'.join(m['text'] for m in matches).lower()
    score = 0
    score += 10 if ('subagent' in lower or 'sub-agent' in lower or 'sub agent' in lower or 'runsubagent' in lower) else 0
    score += 5 if ('delegate' in lower or 'delegation' in lower or 'delegatetool' in lower) else 0
    score += 4 if ('handoff' in lower) else 0
    score += 3 if ('supervisor' in lower or 'swarm' in lower) else 0
    score += 2 if ('as_tool' in lower or 'agent as tool' in lower) else 0
    results.append({'repo': repo, 'score': score, 'match_count': len(matches), 'matches': matches})

(base/'subagent_triage_existing.json').write_text(json.dumps(results, indent=2))
with (base/'subagent_triage_existing_summary.md').open('w') as f:
    for row in sorted(results, key=lambda x: (x['score'], x['match_count']), reverse=True):
        f.write(f"## {row['repo']} — score {row['score']}, matches {row['match_count']}\n\n")
        for m in row['matches'][:20]:
            f.write(f"- `{m['file']}:{m['line']}` {m['text']}\n")
        f.write('\n')
for row in sorted(results, key=lambda x: (x['score'], x['match_count']), reverse=True):
    print(f"{row['score']:>2} {row['match_count']:>4} {row['repo']}")
    for m in row['matches'][:5]:
        print(f"      {m['file']}:{m['line']} {m['text'][:140]}")
