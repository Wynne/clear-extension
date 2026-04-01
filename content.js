const STORAGE_KEY = "clearAllergens";
const LATEST_SCAN_KEY = "clearLatestScan";

const USER_PROMPT_INSTRUCTIONS = `You are a Universal Ingredient Expert—equally versed in food allergen science and in cosmetic/household product chemistry (INCI names, surfactants, preservatives, fragrances).

Context: You will analyze labels from both Food (groceries) and Chemical domains (beauty, personal care, household). Infer the primary domain from what you see: typical food ingredient lists vs INCI-style names, CAS-like patterns, long systematic chemical names, or clear product-type cues in the text. Apply the scientific logic that fits that domain. If the list is mixed, evaluate each hit with the appropriate lens (food vs formulation chemistry).

Medical and formulation knowledge: Understand botanical cross-reactivity for foods, and documented formulation-derived links for cosmetics (e.g. coconut / coconut oil derivatives vs surfactants built from those feedstocks).

Food cross-reactivity (examples—be aggressive when these patterns apply): Pistachio allergy ↔ Cashew; Pecan allergy ↔ Walnut; Prawn or shrimp allergy ↔ other crustaceans named in the list (crab, lobster, crawfish, krill, etc.). Use the same discipline for other established food groups only (e.g. related tree nuts, crustacean class).

Chemical / formulation cross-reactivity (examples): Coconut or coconut-oil allergy ↔ ingredients clearly derived from coconut feedstock, such as Cocamidopropyl Betaine, coco-glucoside, sodium coco-sulfate, and similar INCI names that indicate coconut origin—when such a derivative appears and matches the user's flagged chemical/skin concern, treat as high risk.

Cross-reactivity wording: When you flag because of cross-reactivity (not only a literal string match to the user's list entry), the Reason must say exactly: Flagged because [Ingredient] is cross-reactive with your [Allergen] allergy.

Balance: Be aggressive for established food cousins and for well-documented formulation derivatives (as above). For unrelated items with no direct match, true derivative, or established cross-reactive link, you MUST return SAFE. Do not equate shea butter with peanut, and do not flag stearic acid as nut-derived unless the label specifies animal or problematic source.

Rules:
1) Doubt Rule (non-cousin / non-derivative cases): If you are not 100% certain there is a direct match, true derivative, or an established food/chemical cross-reactivity link, you MUST return SAFE.
2) No Safe Lists: Do NOT list safe ingredients. If the product is safe, respond exactly with: SAFE
3) Context awareness: For grocery tree-nut allergy, coconut is not a tree nut; for coconut-specific allergy on cosmetic labels, still evaluate coconut-derived INCI ingredients per Chemical cross-reactivity above. Shea butter is not peanut. Stearic acid is usually vegetable-based unless the label states otherwise.
4) Evidence requirement: If you flag risk, you MUST provide the exact word from the provided ingredient text that triggered the flag (the ingredient name as written). If you cannot identify a specific triggering word from the provided text, return SAFE.
5) Cross-contamination: Check for "may contain", "processed in a facility with", or similar warnings and include them only when present.
6) Format for risk responses:
Risk: [Ingredient Name]
Trigger: [Exact word copied from the ingredient text]
Reason: [Specific reason; use the cross-reactivity sentence above when applicable]
Note: [Cross-contamination warning if applicable, otherwise "None"]

Use English only.`;

console.log("Clear: Extension loaded", window.location.href);

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function notifyBadge(type) {
  try {
    chrome.runtime.sendMessage({ type }, () => {
      if (chrome.runtime.lastError) {
        /* ignore missing receiver */
      }
    });
  } catch {
    /* ignore message failures */
  }
}

function saveLatestScan(status, resultText) {
  const payload = {
    status,
    resultText,
    url: window.location.href,
    timestamp: Date.now(),
  };
  chrome.storage.local.set({ [LATEST_SCAN_KEY]: payload });
}

function clearLatestScan() {
  chrome.storage.local.remove([LATEST_SCAN_KEY]);
}

/** On-device Gemini Nano often needs well over 5s for the first prompt after load. */
const AI_PROMPT_TIMEOUT_MS = 120000;

function raceWithAiTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      console.log("Clear: AI Timeout");
      reject(
        Object.assign(new Error("AI timed out"), { code: "CLEAR_AI_TIMEOUT" })
      );
    }, ms);
  });
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

function downloadProgressMonitor(monitor) {
  monitor.addEventListener("downloadprogress", (e) => {
    const pct = Math.round((e.loaded ?? 0) * 100);
    console.log("Clear: Model download progress:", pct + "%");
  });
}

async function getExtensionLanguageModelOptions() {
  if (typeof LanguageModel === "undefined" || !LanguageModel.params) {
    return {};
  }
  try {
    const params = await LanguageModel.params();
    if (
      params == null ||
      typeof params !== "object" ||
      params.defaultTopK == null ||
      params.defaultTemperature == null
    ) {
      return {};
    }
    return { topK: params.defaultTopK, temperature: params.defaultTemperature };
  } catch {
    return {};
  }
}

async function resolveTextSessionOptionsFromAi(ai) {
  const sessionOptions = {};
  try {
    if (typeof ai.defaultTextSessionOptions === "function") {
      const defaults = await ai.defaultTextSessionOptions();
      if (defaults && typeof defaults === "object") {
        Object.assign(sessionOptions, defaults);
      }
    } else if (
      ai.defaultTextSessionOptions &&
      typeof ai.defaultTextSessionOptions === "object"
    ) {
      Object.assign(sessionOptions, { ...ai.defaultTextSessionOptions });
    }
  } catch {
    /* ignore invalid defaultTextSessionOptions */
  }
  const lmOpts = await getExtensionLanguageModelOptions();
  if (sessionOptions.topK === undefined && lmOpts.topK !== undefined) {
    sessionOptions.topK = lmOpts.topK;
  }
  if (
    sessionOptions.temperature === undefined &&
    lmOpts.temperature !== undefined
  ) {
    sessionOptions.temperature = lmOpts.temperature;
  }
  sessionOptions.expectedLanguage = "en";
  return sessionOptions;
}

function isProductPage() {
  return /\/dp\//.test(window.location.pathname);
}

function normalizeHeading(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function collectRowFromProdTable(thEl) {
  const tr = thEl.closest("tr");
  if (!tr) return "";
  const td = tr.querySelector("td");
  return td ? td.innerText.replace(/\s+/g, " ").trim() : "";
}

function textFromTablesForLabels(labels) {
  const normalized = labels.map(normalizeHeading);
  const thSelectors = [
    "table.prodDetTable th",
    "table.a-keyvalue.prodDetTable th",
    "#productDetails_feature_div table th",
    "#productDetails_techSpec_section_1 table th",
    "#prodDetails table th",
  ];
  const seen = new Set();
  const chunks = [];

  thSelectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((th) => {
      const h = normalizeHeading(th.textContent);
      if (!h) return;
      const match = normalized.some(
        (l) => h === l || h.includes(l) || l.includes(h)
      );
      if (!match) return;
      const key = th.textContent + "|" + th.getBoundingClientRect().top;
      if (seen.has(key)) return;
      seen.add(key);
      const body = collectRowFromProdTable(th);
      if (body) chunks.push(`${th.textContent.trim()}: ${body}`);
    });
  });

  return chunks.join("\n\n");
}

function sectionByPlainHeading(keywords) {
  const chunks = [];
  const headings = document.querySelectorAll(
    "h1, h2, h3, h4, h5, th, .a-text-bold, span.a-size-base.a-text-bold"
  );

  headings.forEach((el) => {
    const t = normalizeHeading(el.textContent);
    if (!t) return;
    const hit = keywords.some((k) => t.includes(k));
    if (!hit) return;

    const parts = [];
    let node = el.parentElement;
    for (let i = 0; i < 4 && node; i++) {
      const next = node.nextElementSibling;
      if (next && next.innerText && next.innerText.trim().length > 3) {
        parts.push(next.innerText.replace(/\s+/g, " ").trim());
      }
      node = node.parentElement;
    }
    if (parts.length) {
      chunks.push(`${el.textContent.trim()}:\n${parts.join("\n")}`);
    }
  });

  return chunks.join("\n\n");
}

function extractRelevantText() {
  const fromTables = textFromTablesForLabels([
    "ingredients",
    "important information",
    "important info",
    "safety information",
    "active ingredients",
    "inactive ingredients",
  ]);

  const fromHeadings = sectionByPlainHeading([
    "ingredients",
    "important information",
    "important info",
  ]);

  const merged = [fromTables, fromHeadings].filter(Boolean).join("\n\n");
  return merged.replace(/\s+\n/g, "\n").trim();
}

function loadAllergens() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const data = result[STORAGE_KEY];
      if (!data || typeof data !== "object") {
        resolve({ food: [], chemicals: [], skin: [] });
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

async function createTextSession() {
  const ai = typeof globalThis !== "undefined" ? globalThis.ai : undefined;

  if (typeof LanguageModel !== "undefined" && LanguageModel.create) {
    console.log("Clear: Starting AI Session (LanguageModel)");
    const createOpts = {
      monitor: downloadProgressMonitor,
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    };
    const lmOpts = await getExtensionLanguageModelOptions();
    if (
      lmOpts.topK !== undefined &&
      lmOpts.temperature !== undefined
    ) {
      createOpts.topK = lmOpts.topK;
      createOpts.temperature = lmOpts.temperature;
    }
    return LanguageModel.create(createOpts);
  }

  if (ai && typeof ai.createTextSession === "function") {
    console.log("Clear: Starting AI Session (window.ai)");
    const sessionOptions = await resolveTextSessionOptionsFromAi(ai);
    return ai.createTextSession(sessionOptions);
  }

  throw new Error(
    "Built-in AI (window.ai / LanguageModel) is not available in this browser."
  );
}

async function promptSession(session, text) {
  if (typeof session.prompt === "function") {
    return session.prompt(text);
  }
  if (typeof session.complete === "function") {
    return session.complete(text);
  }
  throw new Error("AI session has no recognized prompt method.");
}

function buildFullPrompt(ingredientText, allergens) {
  const food = allergens.food.length
    ? allergens.food.join(", ")
    : "(none listed)";
  const chemicals = allergens.chemicals.length
    ? allergens.chemicals.join(", ")
    : "(none listed)";
  const skin = allergens.skin.length ? allergens.skin.join(", ") : "(none listed)";

  return `${USER_PROMPT_INSTRUCTIONS}

Important: Your answer must be written in English only.

User allergens — Food: ${food}
User allergens — Chemicals: ${chemicals}
User allergens — Skin irritants: ${skin}

Product text (ingredients / important information):
${ingredientText}`;
}

function responseLooksSafe(responseText) {
  const t = (responseText || "").trim();
  if (!t) return false;
  const firstLine = t.split("\n")[0].trim();
  const core = firstLine.replace(/[.!？?]+$/g, "").trim();
  if (/^safe$/i.test(core)) return true;
  if (/^['"]safe['"]$/i.test(core)) return true;
  return false;
}

function parseRiskResponse(responseText) {
  const text = String(responseText || "").trim();
  const risk = text.match(/^Risk:\s*(.+)$/im);
  const trigger = text.match(/^Trigger:\s*(.+)$/im);
  const reason = text.match(/^Reason:\s*(.+)$/im);
  const note = text.match(/^Note:\s*(.+)$/im);
  return {
    risk: risk ? risk[1].trim() : "",
    trigger: trigger ? trigger[1].trim() : "",
    reason: reason ? reason[1].trim() : "",
    note: note ? note[1].trim() : "",
  };
}

function hasAnyAllergies(allergens) {
  return (
    (allergens.food?.length || 0) +
      (allergens.chemicals?.length || 0) +
      (allergens.skin?.length || 0) >
    0
  );
}

let activeScanToken = 0;
let delayedScanTimer = null;
let lastSeenUrl = window.location.href;

function isStaleToken(token) {
  return token !== activeScanToken;
}

function hasVisibleIngredientsSection() {
  const candidates = document.querySelectorAll(
    "h1, h2, h3, h4, h5, th, .a-text-bold, span.a-size-base.a-text-bold"
  );
  for (const el of candidates) {
    const txt = String(el.textContent || "").trim().toLowerCase();
    if (!txt) continue;
    if (!txt.includes("ingredients") && !txt.includes("important information")) {
      continue;
    }
    if (el.offsetParent !== null) return true;
  }
  return false;
}

async function runOnce(ingredientText, token) {
  if (!isProductPage() || isStaleToken(token)) return;
  if (!ingredientText || !String(ingredientText).trim()) return;

  const allergens = await loadAllergens();
  if (isStaleToken(token)) return;
  if (!hasAnyAllergies(allergens)) {
    notifyBadge("CLEAR_SCAN_IDLE");
    clearLatestScan();
    return;
  }

  let session;
  try {
    session = await createTextSession();
  } catch (e) {
    if (isStaleToken(token)) return;
    console.log("Clear: " + errorMessage(e));
    saveLatestScan("ERROR", "Failed to start AI session: " + errorMessage(e));
    return;
  }

  const fullPrompt = buildFullPrompt(ingredientText, allergens);
  let raw;
  try {
    raw = await raceWithAiTimeout(
      promptSession(session, fullPrompt),
      AI_PROMPT_TIMEOUT_MS
    );
  } catch (e) {
    if (isStaleToken(token)) return;
    if (e && e.code === "CLEAR_AI_TIMEOUT") {
      saveLatestScan("ERROR", "AI timed out before returning a response.");
      try {
        if (typeof session.destroy === "function") session.destroy();
        else if (typeof session.close === "function") session.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    console.log("Clear: " + errorMessage(e));
    saveLatestScan("ERROR", "AI prompt failed: " + errorMessage(e));
    try {
      if (typeof session.destroy === "function") session.destroy();
      else if (typeof session.close === "function") session.close();
    } catch (_) {
      /* ignore */
    }
    return;
  }

  try {
    if (typeof session.destroy === "function") session.destroy();
    else if (typeof session.close === "function") session.close();
  } catch (_) {
    /* ignore */
  }
  if (isStaleToken(token)) return;

  console.log("Clear: AI Session Response:", raw);

  const text =
    typeof raw === "string" ? raw : raw != null ? String(raw) : "";

  if (responseLooksSafe(text)) {
    notifyBadge("CLEAR_SCAN_SAFE");
    saveLatestScan("SAFE", text.trim() || "SAFE");
    return;
  }

  // Guardrail: if model cannot provide exact trigger evidence from ingredient text,
  // we treat uncertain/non-compliant output as SAFE to reduce false positives.
  const parsed = parseRiskResponse(text);
  const normalizedIngredients = ingredientText.toLowerCase();
  const trigger = parsed.trigger.toLowerCase();
  const triggerFoundInIngredients =
    trigger.length > 0 && normalizedIngredients.includes(trigger);
  if (!parsed.risk || !parsed.reason || !triggerFoundInIngredients) {
    console.log("Clear: Non-evidenced risk output, forcing SAFE");
    notifyBadge("CLEAR_SCAN_SAFE");
    saveLatestScan("SAFE", "SAFE");
    return;
  }

  notifyBadge("CLEAR_SCAN_ALERT");
  saveLatestScan("ALERT", text.trim());
}

function waitForRelevantText(maxMs = 45000, intervalMs = 1500) {
  const start = Date.now();

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const tryExtract = () => {
      const t = extractRelevantText();
      if (t && t.length > 8) {
        finish(t);
        return true;
      }
      return false;
    };

    if (tryExtract()) return;

    const timer = setInterval(() => {
      if (tryExtract()) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - start >= maxMs) {
        clearInterval(timer);
        finish("");
      }
    }, intervalMs);
  });
}

async function main(token) {
  console.log("Clear: Main started");
  if (!isProductPage() || isStaleToken(token)) {
    console.log("Clear: Not a supported Amazon product URL, skipping scan");
    notifyBadge("CLEAR_SCAN_IDLE");
    return;
  }
  const allergens = await loadAllergens();
  if (isStaleToken(token)) return;
  if (!hasAnyAllergies(allergens)) {
    console.log("Clear: No allergy targets configured, skipping AI scan");
    notifyBadge("CLEAR_SCAN_IDLE");
    clearLatestScan();
    return;
  }
  console.log("Clear: Amazon Product Page detected");

  notifyBadge("CLEAR_SCAN_START");
  saveLatestScan("SCANNING", "AI scan in progress...");

  const text = await waitForRelevantText();
  if (isStaleToken(token)) return;
  if (!text) {
    console.log("Clear: No ingredient text detected during scan window");
    notifyBadge("CLEAR_SCAN_IDLE");
    saveLatestScan(
      "NOT_FOUND",
      "No ingredient text detected on this page. Please check the product images or description manually."
    );
    return;
  }

  console.log("Clear: Ingredients found");

  await runOnce(text, token);
}

function scheduleVariantScan() {
  const token = ++activeScanToken;
  if (delayedScanTimer) clearTimeout(delayedScanTimer);

  notifyBadge("CLEAR_SCAN_IDLE");
  clearLatestScan();

  delayedScanTimer = setTimeout(async () => {
    if (isStaleToken(token)) return;
    if (!isProductPage()) {
      notifyBadge("CLEAR_SCAN_IDLE");
      return;
    }

    // Give Amazon time to render updated variant details before scanning.
    const visible = hasVisibleIngredientsSection();
    const extracted = extractRelevantText();
    if (!visible && !extracted) {
      notifyBadge("CLEAR_SCAN_IDLE");
      saveLatestScan(
        "NOT_FOUND",
        "No ingredient text detected on this page. Please check the product images or description manually."
      );
      return;
    }

    await main(token);
  }, 2000);
}

function maybeHandleUrlChange() {
  const href = window.location.href;
  if (href === lastSeenUrl) return;
  lastSeenUrl = href;
  console.log("Clear: URL changed, scheduling rescan");
  scheduleVariantScan();
}

function installUrlListener() {
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigate", () => {
      maybeHandleUrlChange();
    });
  }
  setInterval(maybeHandleUrlChange, 500);
}

installUrlListener();
scheduleVariantScan();
