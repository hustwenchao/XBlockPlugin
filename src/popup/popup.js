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

const LANG_NAMES = {
  zh: "中文", en: "英语", ja: "日语", ko: "韩语", es: "西班牙语",
  fr: "法语", de: "德语", ru: "俄语", ar: "阿拉伯语", pt: "葡萄牙语",
  it: "意大利语", th: "泰语", vi: "越南语", id: "印尼语", tr: "土耳其语",
  hi: "印地语", nl: "荷兰语", pl: "波兰语", uk: "乌克兰语", fa: "波斯语",
  he: "希伯来语", sv: "瑞典语", da: "丹麦语", no: "挪威语", fi: "芬兰语",
  cs: "捷克语", el: "希腊语", ro: "罗马尼亚语", hu: "匈牙利语", ms: "马来语",
  bn: "孟加拉语", ta: "泰米尔语", ur: "乌尔都语", tl: "他加禄语"
};
const langLabel = code => LANG_NAMES[code] || code.toUpperCase();

async function loadLangStats() {
  const { xbsbLangStats = {} } = await chrome.storage.local.get("xbsbLangStats");

  const totals = {};
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = xbsbLangStats[todayKey(d)];
    if (!day) continue;
    for (const [k, v] of Object.entries(day.langs || {})) {
      totals[k] = (totals[k] || 0) + v;
      total += v;
    }
  }

  $("langMeta").textContent = `${total} 条`;
  const list = $("langList");
  list.innerHTML = "";

  if (total === 0) {
    const empty = document.createElement("li");
    empty.className = "lang-empty";
    empty.textContent = "暂无被 X 翻译的非中英文帖子";
    list.appendChild(empty);
    return;
  }

  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = top[0][1];
  for (const [code, count] of top) {
    const row = document.createElement("li");
    row.className = "lang-row";
    row.innerHTML = `
      <span class="lang-name"></span>
      <span class="lang-bar"><span class="lang-fill"></span></span>
      <span class="lang-count"></span>
    `;
    row.querySelector(".lang-name").textContent = langLabel(code);
    row.querySelector(".lang-fill").style.width = `${(count / max) * 100}%`;
    row.querySelector(".lang-count").textContent = count;
    list.appendChild(row);
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

async function init() {
  const s = await getSettings();
  applyTheme(s.theme || "system");
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
  await loadLangStats();
  // Refresh stats live while popup is open (e.g. user scrolls a tab in background).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.xbsbStats) loadStats();
    if (changes.xbsbLangStats) loadLangStats();
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
