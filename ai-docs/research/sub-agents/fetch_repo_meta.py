import json
import time
import urllib.request
from pathlib import Path

repos = [line.strip() for line in Path('/home/ubuntu/subagent_research/candidate_repos.txt').read_text().splitlines() if line.strip()]
out = []
for repo in repos:
    url = f'https://api.github.com/repos/{repo}'
    try:
        req = urllib.request.Request(url, headers={'Accept':'application/vnd.github+json','User-Agent':'bodhi-subagent-research'})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        out.append({
            'repo': repo,
            'exists': True,
            'full_name': data.get('full_name'),
            'stars': data.get('stargazers_count'),
            'forks': data.get('forks_count'),
            'updated_at': data.get('updated_at'),
            'pushed_at': data.get('pushed_at'),
            'language': data.get('language'),
            'description': data.get('description'),
            'html_url': data.get('html_url'),
            'license': (data.get('license') or {}).get('spdx_id'),
            'archived': data.get('archived'),
        })
    except Exception as e:
        out.append({'repo': repo, 'exists': False, 'error': str(e)})
    time.sleep(0.2)
Path('/home/ubuntu/subagent_research/repo_meta.json').write_text(json.dumps(out, indent=2))
for row in sorted([x for x in out if x.get('exists')], key=lambda x: x.get('stars') or 0, reverse=True):
    print(f"{row['stars']:>7} {row['full_name']:<40} {row['language'] or '-':<12} {row['pushed_at'][:10]} {row['description']}")
print('\nMissing/errors:')
for row in out:
    if not row.get('exists'):
        print(row)
