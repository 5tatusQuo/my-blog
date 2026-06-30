#!/usr/bin/env python3
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
BLOG_DIR = ROOT / "blog"


def clean_text(value):
    return re.sub(r"\s+", " ", unescape(value)).strip()


def markdown_code(value):
    if "`" not in value:
        return f"`{value}`"
    if "``" not in value:
        return f"``{value}``"
    return f"`{value.replace('`', '&#96;')}`"


class ArticleMetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_article = False
        self.article_depth = 0
        self.capture = None
        self.current = []
        self.title = ""
        self.date = ""
        self.tags = []
        self.description = ""
        self.pending_tag = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)

        if tag == "meta" and attrs.get("name") == "description":
            self.description = attrs.get("content", "")

        if tag == "article" and "post" in attrs.get("class", "").split():
            self.in_article = True
            self.article_depth = 1
            return

        if not self.in_article:
            return

        self.article_depth += 1

        if tag == "p" and "date" in attrs.get("class", "").split():
            self.capture = "date"
            self.current = []
        elif tag == "h1" and not self.title:
            self.capture = "title"
            self.current = []
        elif tag == "p" and "tags" in attrs.get("class", "").split():
            self.capture = "tags"
        elif self.capture == "tags" and tag == "span":
            self.pending_tag = True
            self.current = []

    def handle_endtag(self, tag):
        if not self.in_article:
            return

        if tag == "p" and self.capture == "date":
            self.date = clean_text("".join(self.current))
            self.capture = None
        elif tag == "h1" and self.capture == "title":
            self.title = clean_text("".join(self.current))
            self.capture = None
        elif tag == "span" and self.capture == "tags" and self.pending_tag:
            tag_text = clean_text("".join(self.current))
            if tag_text:
                self.tags.append(tag_text)
            self.pending_tag = False
            self.current = []
        elif tag == "p" and self.capture == "tags":
            self.capture = None

        self.article_depth -= 1
        if self.article_depth == 0:
            self.in_article = False

    def handle_data(self, data):
        if self.capture in {"date", "title"} or self.pending_tag:
            self.current.append(data)


class ContentMarkdownParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_content = False
        self.content_depth = 0
        self.blocks = []
        self.block = None
        self.parts = []
        self.heading_level = 2
        self.link_stack = []
        self.in_pre = False
        self.pre_parts = []
        self.in_figure = False
        self.figure = None
        self.in_figcaption = False
        self.list_stack = []

    def push_block(self, block):
        block = block.strip()
        if block:
            self.blocks.append(block)

    def push_text(self, data):
        if self.in_pre:
            self.pre_parts.append(data)
            return

        if self.block or self.in_figcaption:
            self.parts.append(data)

    def inline_text(self):
        return re.sub(r"\s+", " ", "".join(self.parts)).strip()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)

        if tag == "div" and "content" in attrs.get("class", "").split():
            self.in_content = True
            self.content_depth = 1
            return

        if not self.in_content:
            return

        if tag not in self.VOID_TAGS:
            self.content_depth += 1

        if self.in_pre:
            return

        if tag in {"p", "li"}:
            self.block = tag
            self.parts = []
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.block = "heading"
            self.heading_level = min(6, int(tag[1]) + 1)
            self.parts = []
        elif tag == "pre":
            self.in_pre = True
            self.pre_parts = []
        elif tag == "figure":
            self.in_figure = True
            self.figure = {"src": "", "alt": "", "caption": ""}
        elif tag == "figcaption":
            self.in_figcaption = True
            self.parts = []
        elif tag == "img":
            src = attrs.get("src", "")
            alt = attrs.get("alt", "")
            if self.in_figure and self.figure is not None:
                self.figure["src"] = src
                self.figure["alt"] = alt
            else:
                self.push_block(f"![{alt}]({src})")
        elif tag == "a":
            href = attrs.get("href", "")
            self.parts.append("[")
            self.link_stack.append(href)
        elif tag == "strong":
            self.parts.append("**")
        elif tag == "code":
            self.parts.append("`")
        elif tag == "br":
            self.parts.append("\n")
        elif tag in {"ul", "ol"}:
            self.list_stack.append(tag)

    def handle_endtag(self, tag):
        if not self.in_content:
            return

        if tag == "div" and self.content_depth == 1:
            self.in_content = False
            self.content_depth = 0
            return

        if self.in_pre and tag == "pre":
            code = "".join(self.pre_parts).strip("\n")
            fence = "```"
            if "```" in code:
                fence = "````"
            self.push_block(f"{fence}\n{code}\n{fence}")
            self.in_pre = False
            self.pre_parts = []
        elif tag == "p" and self.block == "p":
            self.push_block(self.inline_text())
            self.block = None
            self.parts = []
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self.block == "heading":
            self.push_block(f"{'#' * self.heading_level} {self.inline_text()}")
            self.block = None
            self.parts = []
        elif tag == "li" and self.block == "li":
            marker = "1." if self.list_stack and self.list_stack[-1] == "ol" else "-"
            self.push_block(f"{marker} {self.inline_text()}")
            self.block = None
            self.parts = []
        elif tag in {"ul", "ol"} and self.list_stack:
            self.list_stack.pop()
        elif tag == "figcaption":
            if self.figure is not None:
                self.figure["caption"] = self.inline_text()
            self.in_figcaption = False
            self.parts = []
        elif tag == "figure":
            if self.figure is not None:
                alt = self.figure["alt"].replace("]", "\\]")
                src = self.figure["src"]
                caption = self.figure["caption"].replace('"', '\\"')
                if caption:
                    self.push_block(f'![{alt}]({src} "{caption}")')
                else:
                    self.push_block(f"![{alt}]({src})")
            self.in_figure = False
            self.figure = None
        elif tag == "a" and self.link_stack:
            href = self.link_stack.pop()
            self.parts.append(f"]({href})")
        elif tag == "strong":
            self.parts.append("**")
        elif tag == "code" and not self.in_pre:
            self.parts.append("`")

        if self.content_depth > 0:
            self.content_depth -= 1

    def handle_data(self, data):
        self.push_text(data)

    def handle_entityref(self, name):
        self.push_text(unescape(f"&{name};"))

    def handle_charref(self, name):
        self.push_text(unescape(f"&#{name};"))


def front_matter(metadata):
    def quoted(value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

    tags = ", ".join(metadata.tags)
    return (
        "---\n"
        f"title: {quoted(metadata.title)}\n"
        f"date: {quoted(metadata.date)}\n"
        f"description: {quoted(metadata.description)}\n"
        f"tags: [{tags}]\n"
        "---\n\n"
    )


def wrapper(metadata):
    tag_html = "".join(f"<span>{escape(tag)}</span>" for tag in metadata.tags)
    description = escape(metadata.description, quote=True)
    title = escape(metadata.title)
    date = escape(metadata.date)
    return f"""<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} | Quo's Blog</title>
  <meta name="description" content="{description}">
  <link rel="stylesheet" href="../../style.css">
  <script src="../../static/js/markdown-post.js" defer></script>
</head>
<body>
  <div class="container">
    <header class="site-header">
      <a class="site-title" href="../../index.html">Quo's Blog</a>
      <nav aria-label="Primary navigation">
        <a href="../../blog/index.html">Blog</a>
        <a href="../../projects/index.html">Projects</a>
        <span class="nav-social" aria-label="Social links">
          <a class="icon-link" href="https://github.com/5tatusQuo" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><span class="brand-icon github-icon" aria-hidden="true"></span></a>
          <a class="icon-link" href="https://x.com/5tatusQuo" target="_blank" rel="noopener noreferrer" aria-label="X"><span class="brand-icon x-icon" aria-hidden="true"></span></a>
        </span>
      </nav>
    </header>
    <main>
      <article class="post" data-markdown="post.md">
        <p class="date" data-post-date>{date}</p>
        <h1 data-post-title>{title}</h1>
        <p class="tags" data-post-tags>{tag_html}</p>
        <div class="content" data-markdown-content>
          <p class="muted">Loading post...</p>
        </div>
        <noscript>
          <p class="muted">JavaScript is required to render this markdown post. <a href="post.md">Open the markdown file</a>.</p>
        </noscript>
        <p class="back"><a href="../index.html">back to blog</a></p>
      </article>
    </main>
    <footer>
      <span>Quo's Blog</span><span> · </span><a href="../../index.html">Home</a><span> · </span><a href="../../blog/index.html">Blog</a><span> · </span><a href="../../projects/index.html">Projects</a>
    </footer>
  </div>
</body>
</html>
"""


def convert_post(path):
    html = path.read_text(encoding="utf-8")

    metadata = ArticleMetadataParser()
    metadata.feed(html)

    content = ContentMarkdownParser()
    content.feed(html)

    markdown = front_matter(metadata) + "\n\n".join(content.blocks).strip() + "\n"
    (path.parent / "post.md").write_text(markdown, encoding="utf-8")
    path.write_text(wrapper(metadata), encoding="utf-8")


def main():
    for path in sorted(BLOG_DIR.glob("*/index.html")):
        convert_post(path)


if __name__ == "__main__":
    main()
