(function () {
  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseFrontMatter(markdown) {
    if (!markdown.startsWith("---\n")) {
      return { data: {}, body: markdown };
    }

    const end = markdown.indexOf("\n---", 4);
    if (end === -1) {
      return { data: {}, body: markdown };
    }

    const frontMatter = markdown.slice(4, end).trim();
    const body = markdown.slice(end + 4).replace(/^\s+/, "");
    const data = {};

    frontMatter.split(/\r?\n/).forEach((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) {
        return;
      }

      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();

      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((item) => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        value = value.replace(/^["']|["']$/g, "").replace(/\\"/g, '"');
      }

      data[key] = value;
    });

    return { data, body };
  }

  function parseInline(markdown) {
    const codeValues = [];
    let text = markdown.replace(/`([^`]+)`/g, (_, code) => {
      codeValues.push("<code>" + escapeHtml(code) + "</code>");
      return "\u0000CODE" + (codeValues.length - 1) + "\u0000";
    });

    text = escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

    return text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeValues[Number(index)]);
  }

  function renderList(lines, startIndex) {
    const ordered = /^\d+\.\s+/.test(lines[startIndex]);
    const tag = ordered ? "ol" : "ul";
    const itemPattern = ordered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
    let index = startIndex;
    const items = [];

    while (index < lines.length) {
      const match = lines[index].match(itemPattern);
      if (!match) {
        break;
      }

      items.push("<li>" + parseInline(match[1].trim()) + "</li>");
      index += 1;
    }

    return {
      html: "<" + tag + ">" + items.join("") + "</" + tag + ">",
      nextIndex: index
    };
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function renderTable(lines, startIndex) {
    const headers = splitTableRow(lines[startIndex]);
    let index = startIndex + 2;
    const rows = [];

    while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
      rows.push(splitTableRow(lines[index]));
      index += 1;
    }

    const headerHtml = headers.map((cell) => "<th>" + parseInline(cell) + "</th>").join("");
    const bodyHtml = rows
      .map((row) => "<tr>" + row.map((cell) => "<td>" + parseInline(cell) + "</td>").join("") + "</tr>")
      .join("");

    return {
      html: "<table><thead><tr>" + headerHtml + "</tr></thead><tbody>" + bodyHtml + "</tbody></table>",
      nextIndex: index
    };
  }

  function renderMarkdown(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1];
        const code = [];
        index += 1;

        while (index < lines.length && !lines[index].startsWith(marker)) {
          code.push(lines[index]);
          index += 1;
        }

        if (index < lines.length) {
          index += 1;
        }

        html.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = Math.min(6, heading[1].length);
        html.push("<h" + level + ">" + parseInline(heading[2].trim()) + "</h" + level + ">");
        index += 1;
        continue;
      }

      const image = line.match(/^!\[([^\]]*)\]\((\S+)(?:\s+"([^"]+)")?\)$/);
      if (image) {
        const alt = escapeHtml(image[1]);
        const src = escapeHtml(image[2]);
        const caption = image[3] ? parseInline(image[3]) : "";
        const captionHtml = caption ? "<figcaption>" + caption + "</figcaption>" : "";
        html.push('<figure><button class="image-preview-trigger" type="button" data-preview-src="' + src + '" data-preview-alt="' + alt + '"><img src="' + src + '" alt="' + alt + '"></button>' + captionHtml + "</figure>");
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [line.replace(/^>\s?/, "").trim()];
        index += 1;

        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^>\s?/, "").trim());
          index += 1;
        }

        html.push("<blockquote><p>" + parseInline(quote.join(" ")) + "</p></blockquote>");
        continue;
      }

      if (/^([-*]|\d+\.)\s+/.test(line)) {
        const list = renderList(lines, index);
        html.push(list.html);
        index = list.nextIndex;
        continue;
      }

      if (index + 1 < lines.length && /\|/.test(line) && isTableSeparator(lines[index + 1])) {
        const table = renderTable(lines, index);
        html.push(table.html);
        index = table.nextIndex;
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;

      while (
        index < lines.length &&
        lines[index].trim() &&
        !/^(`{3,}|~{3,})/.test(lines[index]) &&
        !/^(#{1,6})\s+/.test(lines[index]) &&
        !/^!\[([^\]]*)\]\((\S+)(?:\s+"([^"]+)")?\)$/.test(lines[index]) &&
        !/^>\s?/.test(lines[index]) &&
        !/^([-*]|\d+\.)\s+/.test(lines[index]) &&
        !(index + 1 < lines.length && /\|/.test(lines[index]) && isTableSeparator(lines[index + 1]))
      ) {
        paragraph.push(lines[index].trim());
        index += 1;
      }

      html.push("<p>" + parseInline(paragraph.join(" ")) + "</p>");
    }

    return html.join("\n");
  }

  function applyMetadata(article, data) {
    const title = article.querySelector("[data-post-title]");
    const date = article.querySelector("[data-post-date]");
    const tags = article.querySelector("[data-post-tags]");

    if (data.title && title) {
      title.textContent = data.title;
      document.title = data.title + " | Quo's Blog";
    }

    if (data.description) {
      const description = document.querySelector('meta[name="description"]');
      if (description) {
        description.setAttribute("content", data.description);
      }
    }

    if (data.date && date) {
      date.textContent = data.date;
    }

    if (Array.isArray(data.tags) && tags) {
      tags.innerHTML = "";
      data.tags.forEach((tag) => {
        const item = document.createElement("span");
        item.textContent = tag;
        tags.appendChild(item);
      });
    }
  }

  function getPreview() {
    let preview = document.querySelector("[data-image-preview]");
    if (preview) {
      return preview;
    }

    preview = document.createElement("div");
    preview.className = "image-preview";
    preview.setAttribute("data-image-preview", "");
    preview.setAttribute("hidden", "");
    preview.innerHTML = '<button class="image-preview-close" type="button" aria-label="Close preview">x</button><img alt="">';
    document.body.appendChild(preview);

    preview.addEventListener("click", (event) => {
      if (event.target === preview || event.target.closest(".image-preview-close")) {
        closePreview(preview);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !preview.hasAttribute("hidden")) {
        closePreview(preview);
      }
    });

    return preview;
  }

  function closePreview(preview) {
    preview.setAttribute("hidden", "");
    document.body.classList.remove("has-image-preview");
  }

  function bindImagePreviews(target) {
    target.querySelectorAll("[data-preview-src]").forEach((button) => {
      button.addEventListener("click", () => {
        const preview = getPreview();
        const image = preview.querySelector("img");
        image.src = button.getAttribute("data-preview-src");
        image.alt = button.getAttribute("data-preview-alt") || "";
        preview.removeAttribute("hidden");
        document.body.classList.add("has-image-preview");
        preview.querySelector(".image-preview-close").focus();
      });
    });
  }

  document.querySelectorAll("[data-markdown]").forEach((article) => {
    const target = article.querySelector("[data-markdown-content]");
    const source = article.getAttribute("data-markdown");

    fetch(source)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Unable to load " + source);
        }
        return response.text();
      })
      .then((markdown) => {
        const parsed = parseFrontMatter(markdown);
        applyMetadata(article, parsed.data);
        target.innerHTML = renderMarkdown(parsed.body);
        bindImagePreviews(target);
      })
      .catch(() => {
        target.innerHTML = '<p class="muted">This post could not be loaded. <a href="' + source + '">Open the markdown file</a>.</p>';
      });
  });
})();
