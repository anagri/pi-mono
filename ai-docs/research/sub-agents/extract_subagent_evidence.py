from pathlib import Path
import re

root = Path('/home/ubuntu/subagent_research/repos')
patterns = [
    re.compile(r'subagent|sub-agent', re.I),
    re.compile(r'\bdelegate\b|handoff|transfer_to|swarm|crew|team|supervisor|manager', re.I),
    re.compile(r'TaskTool|task tool|AgentTool|agent tool|spawn_subagent|fork', re.I),
]
exclude_dirs = {'.git','node_modules','target','.venv','venv','dist','build','.next','coverage','__pycache__','.mypy_cache','.pytest_cache'}
exts = {'.py','.ts','.tsx','.rs','.go','.md','.cs','.java','.json','.yaml','.yml'}

for repo in sorted([p for p in root.iterdir() if p.is_dir()]):
    scores=[]
    for p in repo.rglob('*'):
        if not p.is_file() or p.suffix.lower() not in exts:
            continue
        if any(part in exclude_dirs for part in p.parts):
            continue
        try:
            txt=p.read_text(errors='ignore')
        except Exception:
            continue
        hits=[]
        for i,line in enumerate(txt.splitlines(),1):
            if any(pat.search(line) for pat in patterns):
                hits.append((i,line.strip()))
        if hits:
            # prefer source over docs/tests, exact subagent over broad terms
            rel=str(p.relative_to(repo))
            score=len(hits)
            if re.search(r'subagent|TaskTool|AgentTool|spawn_subagent|handoff|swarm|crew|team', txt, re.I): score += 20
            if '/test' in rel or rel.startswith('test') or '/docs' in rel or rel.startswith('docs') or rel.endswith('.md'): score -= 8
            if any(x in rel.lower() for x in ['subagent','agent','task','handoff','team','crew','swarm','delegate']): score += 10
            scores.append((score,rel,hits[:8]))
    print(f"\n## {repo.name}")
    for score,rel,hits in sorted(scores, reverse=True)[:8]:
        print(f"### {score} {rel}")
        for i,line in hits[:8]:
            print(f"{i}: {line[:240]}")
