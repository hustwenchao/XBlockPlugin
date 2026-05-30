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
  const countedLangIds = new Set();

  // Serialize storage read-modify-write so concurrent bumps don't clobber each
  // other, and debounce flushes so a scroll-burst of 50 tweets results in
  // one storage write (and one popup re-render) instead of 50.
  let statsQueue = Promise.resolve();
  function updateStored(key, mutator) {
    statsQueue = statsQueue.then(async () => {
      try {
        const obj = await chrome.storage.local.get(key);
        const next = mutator(obj[key] || {});
        if (next !== undefined) await chrome.storage.local.set({ [key]: next });
      } catch (e) {
        console.warn("[XBSB] stats update failed:", e);
      }
    });
    return statsQueue;
  }

  // In-memory deltas accumulated since the last flush.
  const pendingLang = { langs: {}, total: 0, dirty: false };
  const pendingSpam = { total: 0, keyword: 0, llm: 0, dirty: false };
  let flushTimer = null;
  const FLUSH_DELAY_MS = 250;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
  }

  function flushPending() {
    flushTimer = null;
    const key = todayKey();
    const cutoff = todayKey(new Date(Date.now() - 60 * 86400_000));

    if (pendingLang.dirty) {
      const delta = { langs: pendingLang.langs, total: pendingLang.total };
      pendingLang.langs = {};
      pendingLang.total = 0;
      pendingLang.dirty = false;
      updateStored("xbsbLangStats", store => {
        const day = store[key] || { langs: {}, total: 0 };
        if (!day.langs) day.langs = {};
        for (const [code, n] of Object.entries(delta.langs)) {
          day.langs[code] = (day.langs[code] || 0) + n;
        }
        day.total = (day.total || 0) + delta.total;
        store[key] = day;
        for (const k of Object.keys(store)) if (k < cutoff) delete store[k];
        return store;
      });
    }

    if (pendingSpam.dirty) {
      const delta = {
        total: pendingSpam.total,
        keyword: pendingSpam.keyword,
        llm: pendingSpam.llm
      };
      pendingSpam.total = 0;
      pendingSpam.keyword = 0;
      pendingSpam.llm = 0;
      pendingSpam.dirty = false;
      updateStored("xbsbStats", store => {
        const day = store[key] || { total: 0, keyword: 0, llm: 0 };
        day.total += delta.total;
        day.keyword += delta.keyword;
        day.llm += delta.llm;
        store[key] = day;
        for (const k of Object.keys(store)) if (k < cutoff) delete store[k];
        return store;
      });
    }
  }

  function todayKey(d = new Date()) {
    // Local-time YYYY-MM-DD so "today" matches the user's wall clock.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ---------- Language detection ----------
  // Reverse map of locale-specific language names → BCP-47 codes. X's UI
  // shows the original language in the viewer's locale ("翻译自 西班牙语" /
  // "Translated from Spanish"), so we need to recognise both.
  const LANG_LABEL_TO_CODE = {
    "中文": "zh", "简体中文": "zh", "繁体中文": "zh", "繁體中文": "zh",
    "英语": "en", "英文": "en",
    "日语": "ja", "日文": "ja",
    "韩语": "ko", "韩文": "ko", "韓語": "ko", "韓文": "ko",
    "西班牙语": "es", "西班牙文": "es",
    "法语": "fr", "法文": "fr",
    "德语": "de", "德文": "de",
    "俄语": "ru", "俄文": "ru",
    "阿拉伯语": "ar", "阿拉伯文": "ar",
    "葡萄牙语": "pt", "葡萄牙文": "pt",
    "意大利语": "it", "意大利文": "it",
    "泰语": "th", "泰文": "th",
    "越南语": "vi", "越南文": "vi",
    "印尼语": "id", "印度尼西亚语": "id",
    "土耳其语": "tr", "土耳其文": "tr",
    "印地语": "hi",
    "荷兰语": "nl", "荷兰文": "nl",
    "波兰语": "pl",
    "乌克兰语": "uk",
    "波斯语": "fa",
    "希伯来语": "he",
    "瑞典语": "sv",
    "丹麦语": "da",
    "挪威语": "no",
    "芬兰语": "fi",
    "捷克语": "cs",
    "希腊语": "el",
    "罗马尼亚语": "ro",
    "匈牙利语": "hu",
    "马来语": "ms",
    "孟加拉语": "bn",
    "他加禄语": "tl", "菲律宾语": "tl",
    "english": "en", "japanese": "ja", "korean": "ko", "spanish": "es",
    "french": "fr", "german": "de", "russian": "ru", "arabic": "ar",
    "portuguese": "pt", "italian": "it", "thai": "th", "vietnamese": "vi",
    "indonesian": "id", "turkish": "tr", "hindi": "hi", "dutch": "nl",
    "polish": "pl", "ukrainian": "uk", "persian": "fa", "hebrew": "he",
    "swedish": "sv", "danish": "da", "norwegian": "no", "finnish": "fi",
    "czech": "cs", "greek": "el", "romanian": "ro", "hungarian": "hu",
    "malay": "ms", "bengali": "bn", "chinese": "zh", "filipino": "tl",
    "tagalog": "tl"
  };

  const TRANSLATED_RE =
    /(?:translated from|已翻译自|翻译自|翻譯自|已翻譯自)\s*[：:]?\s*([A-Za-z\u4e00-\u9fff（）()]+)/i;

  function parseTranslatedLang(article) {
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const scope = textNode?.parentElement || article;
    const m = (scope.innerText || "").match(TRANSLATED_RE);
    if (!m) return null;
    const label = m[1].trim();
    return LANG_LABEL_TO_CODE[label] || LANG_LABEL_TO_CODE[label.toLowerCase()] || null;
  }

  // Languages the viewer reads natively — skip even when X marks them as
  // "translated from", so the stats focus on truly foreign content.
  const SKIP_LANGS = new Set(["zh", "en"]);

  function detectLanguage(article) {
    // Only count posts X has explicitly auto-translated. The "翻译自 X"
    // indicator is the single source of truth — the lang attribute alone is
    // unreliable (X swaps it after translating in place) and uninteresting
    // (most untranslated posts are already in the viewer's language).
    return parseTranslatedLang(article);
  }

  function bumpLangStats(lang, tweetId) {
    if (!lang || SKIP_LANGS.has(lang)) return;
    if (tweetId) {
      if (countedLangIds.has(tweetId)) return;
      countedLangIds.add(tweetId);
    }
    pendingLang.langs[lang] = (pendingLang.langs[lang] || 0) + 1;
    pendingLang.total += 1;
    pendingLang.dirty = true;
    scheduleFlush();
  }

  function bumpStats(source, tweetId) {
    if (tweetId) {
      if (countedIds.has(tweetId)) return;
      countedIds.add(tweetId);
    }
    pendingSpam.total += 1;
    if (source === "keyword") pendingSpam.keyword += 1;
    else if (source === "llm") pendingSpam.llm += 1;
    pendingSpam.dirty = true;
    scheduleFlush();
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

    const text = getTweetText(article);
    const { displayName, handle } = getUserInfo(article);
    // No content yet — X often mounts the article shell before filling it.
    // Don't mark processed; a subsequent mutation inside this article will
    // re-enter via scanRoot's closest-article walk-up.
    if (!text && !displayName && !handle) return;

    article.setAttribute(PROCESSED_ATTR, "1");

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
      return;
    }

    // Visible post — record original language for stats (only when X has
    // explicitly translated it; native zh/en posts are not counted).
    if (article.isConnected) {
      const lang = detectLanguage(article);
      if (lang) bumpLangStats(lang, getTweetId(article));
    }
  }

  function scanRoot(root) {
    if (!root || root.nodeType !== 1) return;
    // Late-arriving content (e.g. tweetText that mounts after the article
    // shell) appears as an added node *inside* an existing unprocessed
    // article. Walk up to find it so the deferred analysis can run.
    if (root.closest) {
      const enclosing = root.closest('article[data-testid="tweet"]');
      if (enclosing && !enclosing.getAttribute(PROCESSED_ATTR)) {
        processArticle(enclosing);
      }
    }
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
