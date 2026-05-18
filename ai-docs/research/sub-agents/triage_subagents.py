import json
import os
import re
import shutil
import subprocess
from pathlib import Path

base = Path('/home/ubuntu/subagent_research')
repos = [line.strip() for line in (base/'top_harness_repos.txt').read_text().splitlines() if line.strip()]
clone_root = base/'repos'
clone_root.mkdir(exist_ok=True)
terms = [
    'subagent', 'sub-agent', 'sub agent', 'delegate', 'delegation', 'handoff', 'supervisor',
    'swarm', 'crew', 'multi-agent', 'multi_agent', 'parallel', 'spawn', 'child agent', 'agent as tool', 'as_tool'
]
pattern = re.compile('|'.join(re.escape(t) for t in terms), re.IGNORECASE)
results = []
for repo in repos:
    safe = repo.replace('/', '__')
    dest = clone_root/safe
    clone_status = 'exists'
    if not dest.exists():
        url = f'https://github.com/{repo}.git'
        try:
            subprocess.run(['git','clone','--depth','1','--filter=blob:none',url,str(dest)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
            clone_status = 'cloned'
        except Exception as e:
            results.append({'repo': repo, 'clone_status': 'failed', 'error': str(e), 'matches': []})
            continue
    matches = []
    try:
        # Use git grep to avoid .git and binary directories. Limit to manageable output per repo.
        cmd = ['git','-C',str(dest),'grep','-n','-I','-i','-E', r'sub-?agent|sub agent|delegate|delegation|handoff|supervisor|swarm|multi.agent|as_tool|agent.*tool|spawn.*agent|child agent']
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        for line in p.stdout.splitlines()[:500]:
            parts = line.split(':',2)
            if len(parts) == 3:
                file, lineno, text = parts
                # Skip noisy package locks and changelogs unless directly subagent-relevant.
                lowfile = file.lower()
                if any(skip in lowfile for skip in ['package-lock', 'pnpm-lock', 'yarn.lock', '.svg', '.jsonl']):
                    continue
                matches.append({'file': file, 'line': int(lineno) if lineno.isdigit() else None, 'text': text.strip()[:300]})
    except Exception as e:
        matches.append({'file': '', 'line': None, 'text': f'grep failed: {e}'})
    score = 0
    lower_blob = '\n'.join(m['text'] for m in matches).lower()
    if 'subagent' in lower_blob or 'sub-agent' in lower_blob or 'sub agent' in lower_blob:
        score += 5
    if 'delegate' in lower_blob or 'delegation' in lower_blob:
        score += 3
    if 'handoff' in lower_blob or 'supervisor' in lower_blob or 'swarm' in lower_blob:
        score += 2
    if 'as_tool' in lower_blob or 'agent as tool' in lower_blob:
        score += 2
    results.append({'repo': repo, 'clone_status': clone_status, 'score': score, 'match_count': len(matches), 'matches': matches[:80]})

(base/'subagent_triage.json').write_text(json.dumps(results, indent=2))
for row in sorted(results, key=lambda x: (x.get('score',0), x.get('match_count',0)), reverse=True):
    print(f"{row.get('score',0):>2} {row.get('match_count',0):>4} {row['repo']} {row.get('clone_status')}")
    for m in row.get('matches', [])[:8]:
        print(f"      {m['file']}:{m['line']} {m['text'][:160]}")
