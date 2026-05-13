(() => {
  "use strict";

  // ---------- Settings (kept in sync with src/shared/settings.js) ----------
  const DEFAULT_SETTINGS = {
    enabled: true,
    keywordEnabled: true,
    keywords: [],
    llmEnabled: false,
    llmBaseUrl: "https://api.openai.com/v1",
    llmApiKey: "",
    llmModel: "gpt-4o-mini",
    llmThreshold: 0.7,
    collapseMode: "fold",
    showReason: true,
    cacheTtlMinutes: 60 * 24
  };

  let settings = { ...DEFAULT_SETTINGS };

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...stored };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
    // Re-scan everything when toggles change so UX feels live.
    rescanAll();
  });

  // ---------- Tweet detection ----------
  const PROCESSED_ATTR = "data-xbsb-processed";
  const COLLAPSED_ATTR = "data-xbsb-collapsed";

  function isStatusPage() {
    return /\/status\/\d+/.test(location.pathname);
  }

  function isOriginalTweet(article) {
    // Heuristic: on a status page, the first tweet article in DOM order is the OP.
    // We mark the OP once we find it, so we never collapse it.
    if (!isStatusPage()) return false;
    const first = document.querySelector('article[data-testid="tweet"]');
    return first === article;
  }

  function getTweetText(article) {
    const node = article.querySelector('[data-testid="tweetText"]');
    return node ? node.innerText.trim() : "";
  }

  function getUserInfo(article) {
    // Twitter renders the display name and @handle inside [data-testid="User-Name"].
    // The structure is roughly: <displayName> · @handle · timestamp
    const nameNode = article.querySelector('[data-testid="User-Name"]');
    if (!nameNode) return { displayName: "", handle: "" };
    const raw = nameNode.innerText || "";
    // Handle line usually starts with "@". Display name is whatever comes before it.
    let displayName = "";
    let handle = "";
    for (const line of raw.split(/\n+/)) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("@") && !handle) handle = t;
      else if (!displayName) displayName = t;
    }
    return { displayName, handle };
  }

  function getTweetId(article) {
    // Try to extract from a status link inside the article.
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const m = link.getAttribute("href").match(/status\/(\d+)/);
    return m ? m[1] : null;
  }

  // ---------- Keyword filter ----------
  function checkKeyword({ text, displayName, handle }) {
    if (!settings.keywordEnabled) return null;
    const haystacks = [
      { label: "正文", value: text },
      { label: "昵称", value: displayName },
      { label: "用户名", value: handle }
    ];
    for (const kw of settings.keywords) {
      const k = String(kw || "").trim();
      if (!k) continue;
      const lk = k.toLowerCase();
      for (const { label, value } of haystacks) {
        if (value && value.toLowerCase().includes(lk)) {
          return { spam: true, reason: `${label}命中: ${k}`, source: "keyword" };
        }
      }
    }
    return { spam: false, source: "keyword" };
  }

  // ---------- LLM filter (via background) ----------
  const llmCache = new Map(); // key -> { spam, reason, ts }

  async function checkLLM({ text, displayName, handle }) {
    if (!settings.llmEnabled) return null;
    if (!settings.llmApiKey) return null;

    const cacheKey = `${displayName}\u0001${handle}\u0001${text}`;
    const cached = llmCache.get(cacheKey);
    const ttl = (settings.cacheTtlMinutes || 1440) * 60_000;
    if (cached && Date.now() - cached.ts < ttl) return cached;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "llm-classify",
        text,
        displayName,
        handle
      });
      if (resp && resp.ok) {
        const result = {
          spam: !!resp.spam,
          reason: resp.reason || "LLM 判定为垃圾",
          source: "llm",
          ts: Date.now()
        };
        llmCache.set(cacheKey, result);
        return result;
      }
    } catch (e) {
      console.warn("[XBSB] LLM check failed:", e);
    }
    return null;
  }

  // ---------- Stats ----------
  // Twitter virtualises rows: the same tweet may scroll in/out and re-mount.
  // Dedupe by tweet id so we don't count the same spam multiple times per session.
  const countedIds = new Set();

  function todayKey(d = new Date()) {
    // Local-time YYYY-MM-DD so "today" matches the user's wall clock.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  async function bumpStats(source, tweetId) {
    if (tweetId) {
      if (countedIds.has(tweetId)) return;
      countedIds.add(tweetId);
    }
    const key = todayKey();
    try {
      const { xbsbStats = {} } = await chrome.storage.local.get("xbsbStats");
      const day = xbsbStats[key] || { total: 0, keyword: 0, llm: 0 };
      day.total += 1;
      if (source === "keyword") day.keyword += 1;
      else if (source === "llm") day.llm += 1;
      xbsbStats[key] = day;
      // Keep only the last 60 days to bound storage size.
      const cutoff = todayKey(new Date(Date.now() - 60 * 86400_000));
      for (const k of Object.keys(xbsbStats)) {
        if (k < cutoff) delete xbsbStats[k];
      }
      await chrome.storage.local.set({ xbsbStats });
    } catch (e) {
      console.warn("[XBSB] stats bump failed:", e);
    }
  }

  // ---------- Collapse UI ----------
  function collapseArticle(article, reason, source) {
    if (article.getAttribute(COLLAPSED_ATTR)) return;
    article.setAttribute(COLLAPSED_ATTR, "1");
    bumpStats(source, getTweetId(article));

    // Find the outer cell (Twitter virtualises rows in cellInnerDiv wrappers).
    const cell = article.closest('[data-testid="cellInnerDiv"]') || article;

    if (settings.collapseMode === "hide") {
      cell.classList.add("xbsb-hidden");
      return;
    }

    // Build a banner; keep the article in place but visually collapsed.
    const banner = document.createElement("div");
    banner.className = "xbsb-banner";
    banner.innerHTML = `
      <span class="xbsb-tag">已折叠</span>
      <span class="xbsb-reason"></span>
      <button type="button" class="xbsb-toggle">展开</button>
    `;
    banner.querySelector(".xbsb-reason").textContent =
      settings.showReason && reason ? reason : "";

    cell.classList.add("xbsb-collapsed-cell");
    cell.prepend(banner);

    const toggle = banner.querySelector(".xbsb-toggle");
    toggle.addEventListener("click", () => {
      const expanded = cell.classList.toggle("xbsb-expanded");
      toggle.textContent = expanded ? "折叠" : "展开";
    });
  }

  // ---------- Pipeline ----------
  async function processArticle(article) {
    if (!settings.enabled) return;
    if (article.getAttribute(PROCESSED_ATTR)) return;
    if (isOriginalTweet(article)) {
      article.setAttribute(PROCESSED_ATTR, "op");
      return;
    }
    article.setAttribute(PROCESSED_ATTR, "1");

    const text = getTweetText(article);
    const { displayName, handle } = getUserInfo(article);
    // Need at least one of: tweet text, displayName, handle.
    if (!text && !displayName && !handle) return;

    const payload = { text, displayName, handle };

    // 1) Keyword first (cheap & sync) — scans text + displayName + handle.
    const kw = checkKeyword(payload);
    if (kw && kw.spam) {
      collapseArticle(article, kw.reason, "keyword");
      return;
    }

    // 2) LLM (async, may be skipped if disabled)
    const llm = await checkLLM(payload);
    if (llm && llm.spam) {
      // Re-check element still exists (Twitter virtualises rows)
      if (article.isConnected) collapseArticle(article, llm.reason, "llm");
    }
  }

  function scanRoot(root) {
    const articles = root.querySelectorAll
      ? root.querySelectorAll('article[data-testid="tweet"]')
      : [];
    articles.forEach(processArticle);
    if (root.matches && root.matches('article[data-testid="tweet"]')) {
      processArticle(root);
    }
  }

  function rescanAll() {
    // Reset processed flags so we re-evaluate against new settings.
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach(el => {
      el.removeAttribute(PROCESSED_ATTR);
    });
    // Restore previously collapsed cells before re-scanning.
    document.querySelectorAll(".xbsb-collapsed-cell").forEach(cell => {
      cell.classList.remove("xbsb-collapsed-cell", "xbsb-expanded");
      cell.querySelectorAll(".xbsb-banner").forEach(b => b.remove());
    });
    document.querySelectorAll(".xbsb-hidden").forEach(el => {
      el.classList.remove("xbsb-hidden");
    });
    document.querySelectorAll(`[${COLLAPSED_ATTR}]`).forEach(el => {
      el.removeAttribute(COLLAPSED_ATTR);
    });
    scanRoot(document.body);
  }

  // ---------- Observer ----------
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType === 1) scanRoot(node);
      });
    }
  });

  // SPA navigation: x.com swaps content without full reload.
  let lastUrl = location.href;
  const urlPoller = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // New page; processed flags from old context are irrelevant.
      setTimeout(rescanAll, 300);
    }
  }, 500);

  async function init() {
    await loadSettings();
    scanRoot(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init().catch(err => console.error("[XBSB] init failed:", err));
})();
