from pathlib import Path
import re, os
root=Path('/home/ubuntu/subagent_research/repos')
exclude={'.git','node_modules','target','.venv','venv','dist','build','.next','coverage','__pycache__','.mypy_cache','.pytest_cache','site-packages','vendor'}
exts={'.py','.ts','.tsx','.rs','.go','.cs'}
terms=re.compile(r'subagent|sub-agent|TaskTool|task tool|AgentTool|spawn_subagent|handoff|delegate|transfer_to|swarm|crew|team|supervisor|manager', re.I)
strong=re.compile(r'subagent|sub-agent|TaskTool|AgentTool|spawn_subagent|handoff|transfer_to|swarm', re.I)
for repo in sorted(p for p in root.iterdir() if p.is_dir()):
    rows=[]
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames if d not in exclude]
        for fn in filenames:
            p=Path(dirpath)/fn
            if p.suffix.lower() not in exts: continue
            rel=str(p.relative_to(repo))
            if any(seg in rel.lower() for seg in ['/test','tests/','/docs','examples/','snapshots/']):
                deprior=8
            else:
                deprior=0
            try:
                if p.stat().st_size>350_000: continue
                lines=p.read_text(errors='ignore').splitlines()
            except Exception: continue
            hits=[]
            for i,l in enumerate(lines,1):
                if terms.search(l): hits.append((i,l.strip()))
                if len(hits)>=12: break
            if hits:
                text='\n'.join(l for _,l in hits)
                score=len(hits)+ (30 if strong.search(text) else 0) + (12 if any(k in rel.lower() for k in ['subagent','task','agent','handoff','team','crew','swarm','delegate']) else 0) - deprior
                rows.append((score,rel,hits[:8]))
    print(f'\n## {repo.name}')
    for score,rel,hits in sorted(rows, reverse=True)[:10]:
        print(f'### {score} {rel}')
        for i,l in hits:
            print(f'{i}: {l[:220]}')
