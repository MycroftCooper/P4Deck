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

const showcase = document.querySelector("[data-showcase]");
if (showcase) {
  const tabList = showcase.querySelector("[data-showcase-tabs]");
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const panels = [...showcase.querySelectorAll("[data-showcase-panel]")];

  function selectShowcase(tab, updateUrl = false) {
    const target = tab.getAttribute("aria-controls");
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.id !== target;
    if (updateUrl) window.history.replaceState(null, "", `#${target}`);
  }

  function tabForHash() {
    return tabs.find(
      (tab) => `#${tab.getAttribute("aria-controls")}` === window.location.hash,
    );
  }

  for (const panel of panels) {
    panel.setAttribute("role", "tabpanel");
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectShowcase(tab, true));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next = {
        ArrowLeft: index - 1,
        ArrowRight: index + 1,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      selectShowcase(target, true);
      target.focus();
    });
  }
  function showHashPanel() {
    const tab = tabForHash();
    if (!tab) return;
    selectShowcase(tab);
    document.getElementById(tab.getAttribute("aria-controls")).scrollIntoView();
  }
  selectShowcase(tabForHash() ?? tabs[0]);
  tabList.hidden = false;
  window.addEventListener("hashchange", showHashPanel);
  if (tabForHash()) requestAnimationFrame(showHashPanel);
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
