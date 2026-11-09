const previewButtons = [...document.querySelectorAll("[data-preview]")];
const previewPanels = [...document.querySelectorAll("[data-panel]")];

for (const button of previewButtons) {
  button.addEventListener("click", () => {
    const scene = button.dataset.preview;
    for (const item of previewButtons) {
      item.setAttribute("aria-pressed", String(item === button));
    }
    for (const panel of previewPanels) {
      panel.hidden = panel.dataset.panel !== scene;
    }
  });
}

const wikiQuery = document.getElementById("wiki-query");
const wikiResults = document.getElementById("wiki-results");
const wikiStatus = document.getElementById("wiki-search-status");
const wikiSections = [...document.querySelectorAll(".doc-chapter")].map(
  (section) => ({
    section,
    title: section.querySelector("h2").textContent,
    index: `${section.textContent} ${section.dataset.keywords}`.toLowerCase(),
  }),
);

if (wikiQuery && wikiResults && wikiStatus) {
  const searchBox = wikiQuery.closest(".docs-search");
  searchBox.hidden = false;

  function closeResults() {
    wikiResults.hidden = true;
    wikiStatus.textContent = "";
  }

  function search() {
    const terms = wikiQuery.value
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    wikiResults.replaceChildren();
    if (!terms.length) {
      closeResults();
      return;
    }
    const matches = wikiSections.filter(({ index }) =>
      terms.every((term) => index.includes(term)),
    );
    for (const { section, title } of matches) {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${section.id}`;
      link.textContent = title;
      link.addEventListener("click", () => {
        section.tabIndex = -1;
        section.focus({ preventScroll: true });
        closeResults();
      });
      row.append(link);
      wikiResults.append(row);
    }
    if (!matches.length) {
      const row = document.createElement("li");
      row.className = "no-result";
      row.textContent = "没有匹配的章节，试试更短的关键词。";
      wikiResults.append(row);
    }
    wikiStatus.textContent = `找到 ${matches.length} 个章节。`;
    wikiResults.hidden = false;
  }

  wikiQuery.addEventListener("input", search);
  wikiQuery.addEventListener("focus", search);
  searchBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !wikiResults.hidden) {
      event.preventDefault();
      wikiQuery.focus();
      closeResults();
    }
    if (
      event.target === wikiQuery &&
      (event.key === "ArrowDown" || event.key === "Enter")
    ) {
      if (wikiResults.hidden) search();
      const firstResult = wikiResults.querySelector("a");
      if (firstResult) {
        event.preventDefault();
        if (event.key === "Enter") firstResult.click();
        else firstResult.focus();
      }
    }
  });
  searchBox.addEventListener("focusout", (event) => {
    if (!searchBox.contains(event.relatedTarget)) closeResults();
  });
  document.addEventListener("click", (event) => {
    if (!searchBox.contains(event.target)) closeResults();
  });
}

const mobileToc = document.querySelector(".mobile-toc");
mobileToc?.addEventListener("click", (event) => {
  if (event.target.closest("a")) mobileToc.open = false;
});

const chapterLinks = [...document.querySelectorAll(".docs-nav a")];
function markChapter() {
  const current = window.location.hash || "#quickstart";
  for (const link of chapterLinks) {
    if (link.hash === current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
if (chapterLinks.length) {
  markChapter();
  window.addEventListener("hashchange", markChapter);
}
