"""Render the maintained beginner guide into the offline PC/mobile help page."""
from pathlib import Path
from html import escape
import re
from markdown_it import MarkdownIt

repo = Path(__file__).resolve().parent.parent
source = repo / 'docs/INSPECTOR_BEGINNER_GUIDE.md'
md = MarkdownIt('commonmark', {'html': False}).enable('table')
tokens = md.parse(source.read_text(encoding='utf-8'))
chapters = []
for i, token in enumerate(tokens):
    if token.type == 'heading_open' and token.tag == 'h2':
        title = tokens[i + 1].content
        chapter = 'lesson-' + str(len(chapters) + 1)
        token.attrSet('id', chapter)
        chapters.append((chapter, title))
content = md.renderer.render(tokens, md.options, {})
content = content.replace('<table>', '<div class="table-scroll"><table>')
content = content.replace('</table>', '</table></div>')
toc = ''.join(f'<li><a href="#{chapter}">{escape(title)}</a></li>' for chapter, title in chapters)
page = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Inspector 新手教程</title><link rel="stylesheet" href="css/inspector-tutorial.css?v=1"></head>
<body><header class="tutorial-header"><span>效果检查器 · 新手教程</span><nav class="standalone-navigation" aria-label="返回"><a href="./inspector.html">返回检查器</a><a href="./index.html">返回游戏</a></nav></header>
<div class="tutorial-layout"><aside><details id="tutorial-toc" open><summary>课程目录</summary><nav aria-label="课程目录"><ol>''' + toc + '''</ol></nav></details></aside><main>''' + content + '''</main></div>
<script>
document.documentElement.classList.toggle('embedded',window.self!==window.top);
const narrow=matchMedia('(max-width: 760px)'),syncToc=()=>{document.getElementById('tutorial-toc').open=!narrow.matches;};syncToc();narrow.addEventListener('change',syncToc);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&window.self!==window.top){event.preventDefault();parent.postMessage({type:'inspector-tutorial-close'},'*');}});
</script></body></html>
'''
for root in ['electron/game', 'kards-mobile/www/game']:
    (repo / root / 'inspector-tutorial.html').write_text(page, encoding='utf-8')
print(f'Rendered {len(chapters)} chapters for PC and mobile')
