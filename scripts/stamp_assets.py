#!/usr/bin/env python3
"""Add ?v=<hash> to the site's own CSS/JS links in index.html so browsers load new code right after a deploy."""
import hashlib, os, re
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
path = os.path.join(root, "index.html")
html = open(path, encoding="utf-8").read()
def stamp(m):
    attr, url = m.group(1), m.group(2)
    f = os.path.join(root, url)
    v = hashlib.sha1(open(f, "rb").read()).hexdigest()[:10]
    return f'{attr}="{url}?v={v}"'
html = re.sub(r'(src|href)="(assets/[^"?]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"', stamp, html)
open(path, "w", encoding="utf-8").write(html)
print("stamped")
