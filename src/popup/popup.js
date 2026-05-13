import { getSettings, setSettings } from "../shared/settings.js";

const $ = id => document.getElementById(id);

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function loadStats() {
  const { xbsbStats = {} } = await chrome.storage.local.get("xbsbStats");
  const today = todayKey();
  const todayCount = xbsbStats[today]?.total || 0;

  let week = 0, total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    week += xbsbStats[todayKey(d)]?.total || 0;
  }
  for (const k of Object.keys(xbsbStats)) total += xbsbStats[k]?.total || 0;

  $("statToday").textContent = todayCount;
  $("stat7d").textContent = week;
  $("statTotal").textContent = total;
}

async function init() {
  const s = await getSettings();
  $("enabled").checked = s.enabled;
  $("keywordEnabled").checked = s.keywordEnabled;
  $("llmEnabled").checked = s.llmEnabled;

  for (const key of ["enabled", "keywordEnabled", "llmEnabled"]) {
    $(key).addEventListener("change", e => {
      setSettings({ [key]: e.target.checked });
    });
  }

  $("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  await loadStats();
  // Refresh stats live while popup is open (e.g. user scrolls a tab in background).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.xbsbStats) loadStats();
  });

  // Show count of collapsed cells in the active tab.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /https:\/\/(x|twitter)\.com/.test(tab.url || "")) {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.querySelectorAll("[data-xbsb-collapsed='1']").length
      });
      $("statText").textContent = `本页已折叠 ${result ?? 0} 条回复`;
    } else {
      $("statText").textContent = "请在 x.com 页面查看";
    }
  } catch {
    /* ignore */
  }
}

init();
