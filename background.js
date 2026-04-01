const BLINK_INTERVAL_MS = 500;

const blinkTimers = new Map();
const blinkVisible = new Map();

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function stopBlink(tabId) {
  const timer = blinkTimers.get(tabId);
  if (timer) {
    clearInterval(timer);
    blinkTimers.delete(tabId);
  }
  blinkVisible.delete(tabId);
}

function startScanningBadge(tabId) {
  stopBlink(tabId);
  setBadge(tabId, "...", "#d4a017");
  blinkVisible.set(tabId, true);

  const timer = setInterval(() => {
    const visible = blinkVisible.get(tabId) !== false;
    blinkVisible.set(tabId, !visible);
    chrome.action.setBadgeText({ tabId, text: visible ? "" : "..." });
  }, BLINK_INTERVAL_MS);

  blinkTimers.set(tabId, timer);
}

function setSafeBadge(tabId) {
  stopBlink(tabId);
  setBadge(tabId, "OK", "#198754");
}

function setAlertBadge(tabId) {
  stopBlink(tabId);
  setBadge(tabId, "!!", "#c5221f");
}

function clearBadge(tabId) {
  stopBlink(tabId);
  chrome.action.setBadgeText({ tabId, text: "" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  if (!tabId || !message || typeof message !== "object") {
    sendResponse({ ok: false });
    return;
  }

  if (message.type === "CLEAR_SCAN_START") {
    startScanningBadge(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "CLEAR_SCAN_SAFE") {
    setSafeBadge(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "CLEAR_SCAN_ALERT") {
    setAlertBadge(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "CLEAR_SCAN_IDLE") {
    clearBadge(tabId);
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopBlink(tabId);
});
