const STORAGE_KEY = "clearAllergens";
const LATEST_SCAN_KEY = "clearLatestScan";

const DEFAULT_DATA = {
  food: [],
  chemicals: [],
  skin: [],
};
let isManageMode = false;

function normalizeEntry(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
  return s.length ? s : null;
}

async function loadAllergens() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const data = result[STORAGE_KEY];
      if (!data || typeof data !== "object") {
        resolve({ ...DEFAULT_DATA });
        return;
      }
      resolve({
        food: Array.isArray(data.food) ? data.food : [],
        chemicals: Array.isArray(data.chemicals) ? data.chemicals : [],
        skin: Array.isArray(data.skin) ? data.skin : [],
      });
    });
  });
}

async function loadLatestScan() {
  return new Promise((resolve) => {
    chrome.storage.local.get([LATEST_SCAN_KEY], (result) => {
      resolve(result[LATEST_SCAN_KEY] || null);
    });
  });
}

function saveAllergens(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: data }, resolve);
  });
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function isAmazonProductUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return /(^|\.)amazon\.com$/i.test(parsed.hostname) && /\/dp\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function renderList(sectionEl, items, categoryKey) {
  const ul = sectionEl.querySelector(".tag-list");
  ul.innerHTML = "";
  items.forEach((label, index) => {
    const li = document.createElement("li");
    li.className = "tag-item";
    li.dataset.index = String(index);

    const span = document.createElement("span");
    span.className = "tag-label";
    span.textContent = label;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-remove";
    btn.textContent = "Remove";
    btn.dataset.category = categoryKey;
    btn.dataset.index = String(index);

    li.append(span, btn);
    ul.appendChild(li);
  });
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function parseFlaggedItems(resultText) {
  const text = String(resultText || "").trim();
  if (!text) return [];
  const blockRegex =
    /Risk:\s*([^\n]+)\n+Reason:\s*([^\n]+)(?:\n+Note:\s*([^\n]+))?/gi;
  const structured = [];
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const ingredient = (match[1] || "").trim();
    const reason = (match[2] || "").trim();
    const note = (match[3] || "").trim();
    const explanation = note
      ? `${reason}\nNote: ${note}`
      : `${reason}\nNote: None`;
    structured.push({
      ingredient: ingredient || "Flagged ingredient",
      explanation,
    });
  }
  if (structured.length) return structured;

  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  if (!lines.length) return [];
  return lines.map((line) => {
    const m = line.match(
      /(?:found|contains|match(?:ed)?|detected)\s+([^:.,;\n-]+)\s*(?:[:\-]\s*)?(.*)/i
    );
    if (m) {
      return {
        ingredient: m[1].trim(),
        explanation: m[2].trim() || line,
      };
    }
    return {
      ingredient: "Flagged ingredient",
      explanation: line,
    };
  });
}

function renderReport(waiting, scan) {
  const headerEl = document.getElementById("report-header");
  const subEl = document.getElementById("report-sub");
  const listEl = document.getElementById("report-list");
  if (!headerEl || !subEl || !listEl) return;

  headerEl.classList.remove("clean", "risk", "waiting");
  listEl.innerHTML = "";

  if (waiting) {
    headerEl.textContent = "CLEAN";
    headerEl.classList.add("waiting");
    subEl.textContent =
      "Welcome to Clear! Go to any Amazon product page (Food, Beauty, or Household) and I will automatically scan the ingredients for you.";
    return;
  }

  if (!scan || typeof scan !== "object" || scan.status === "SCANNING") {
    headerEl.textContent = "CLEAN";
    headerEl.classList.add("clean");
    subEl.textContent = "No risk detected yet for this page.";
    return;
  }

  if (scan.status === "ALERT") {
    headerEl.textContent = "RISK DETECTED";
    headerEl.classList.add("risk");
    const ts = formatTimestamp(scan.timestamp);
    subEl.textContent = ts ? `Analysis completed ${ts}.` : "Potential allergen risk found.";
    const items = parseFlaggedItems(scan.resultText);
    if (!items.length) {
      items.push({
        ingredient: "Flagged ingredient",
        explanation: scan.resultText || "Potential derivative or allergen detected.",
      });
    }
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "report-item";
      const title = document.createElement("p");
      title.className = "report-item-title";
      title.textContent = item.ingredient;
      const body = document.createElement("p");
      body.className = "report-item-text";
      body.textContent = item.explanation;
      li.append(title, body);
      listEl.appendChild(li);
    });
    return;
  }

  if (scan.status === "SAFE") {
    headerEl.textContent = "CLEAN";
    headerEl.classList.add("clean");
    const ts = formatTimestamp(scan.timestamp);
    subEl.textContent = ts
      ? `Analysis completed ${ts}. AI reports this product as SAFE.`
      : "AI reports this product as SAFE.";
    return;
  }

  headerEl.textContent = "CLEAN";
  headerEl.classList.add("clean");
  subEl.textContent = scan.resultText || "No risk detected yet for this page.";
}

function renderMode() {
  const reportView = document.getElementById("report-view");
  const manageView = document.getElementById("manage-view");
  const toggleBtn = document.getElementById("toggle-manage-btn");
  if (!reportView || !manageView || !toggleBtn) return;
  reportView.classList.toggle("hidden", isManageMode);
  manageView.classList.toggle("hidden", !isManageMode);
  toggleBtn.textContent = isManageMode ? "Save and return to report" : "Manage my list";
}

async function refreshUI() {
  const [data, latestScan, activeTab] = await Promise.all([
    loadAllergens(),
    loadLatestScan(),
    getActiveTab(),
  ]);
  document.querySelectorAll(".category").forEach((section) => {
    const key = section.dataset.category;
    const arr =
      key === "food"
        ? data.food
        : key === "chemicals"
          ? data.chemicals
          : data.skin;
    renderList(section, arr, key);
  });
  const activeUrl = activeTab ? activeTab.url : "";
  const waiting = !isAmazonProductUrl(activeUrl);
  const scanForTab =
    !waiting && latestScan && latestScan.url === activeUrl ? latestScan : null;
  renderReport(waiting, scanForTab);
  renderMode();
}

document.querySelectorAll(".category").forEach((section) => {
  const input = section.querySelector(".add-input");
  const addBtn = section.querySelector(".btn-add");
  const key = section.dataset.category;

  const add = async () => {
    const entry = normalizeEntry(input.value);
    if (!entry) return;
    const data = await loadAllergens();
    const list =
      key === "food"
        ? data.food
        : key === "chemicals"
          ? data.chemicals
          : data.skin;
    const lower = list.map((s) => s.toLowerCase());
    if (lower.includes(entry.toLowerCase())) {
      input.value = "";
      input.focus();
      return;
    }
    list.push(entry);
    input.value = "";
    await saveAllergens(data);
    await refreshUI();
    input.focus();
  };

  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
});

document.querySelector(".popup-main").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-remove");
  if (!btn) return;
  const category = btn.dataset.category;
  const index = Number(btn.dataset.index);
  if (!category || Number.isNaN(index)) return;

  const data = await loadAllergens();
  const list =
    category === "food"
      ? data.food
      : category === "chemicals"
        ? data.chemicals
        : data.skin;
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  await saveAllergens(data);
  await refreshUI();
});

refreshUI();

document.getElementById("toggle-manage-btn").addEventListener("click", async () => {
  if (isManageMode) {
    const data = await loadAllergens();
    await saveAllergens(data);
  }
  isManageMode = !isManageMode;
  await refreshUI();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY] || changes[LATEST_SCAN_KEY]) {
    refreshUI();
  }
});
