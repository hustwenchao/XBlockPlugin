// Default settings shape, used by popup/options/content.
export const DEFAULT_SETTINGS = {
  enabled: true,

  // Keyword filter
  keywordEnabled: true,
  keywords: [
    // English bait
    "follow back", "follow me", "DM me", "check my profile",
    "click my link", "free crypto", "airdrop", "giveaway winner",
    // 中文广告/拉粉
    "私信", "加微信", "加我", "推广", "代发", "刷赞", "刷粉",
    // 色情/约炮（含常见显示名套路）
    "线下资源", "同城约", "同城炮", "约爱", "看简介",
    "同步更新", "刚分手", "想被爱", "寂寞", "小哥哥", "小姐姐",
    "出资源", "卖片", "tg@", "v+", "加v",
    // emoji 暗语/谐音
    "打✈️", "约🔥", "福利🎁", "私❤️", "资源📁", "看👉简介"
  ],

  // LLM filter (OpenAI-compatible)
  llmEnabled: false,
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  llmThreshold: 0.7, // model returns confidence; collapse if >= threshold

  // UI
  collapseMode: "fold", // "fold" | "hide"
  showReason: true,

  // Caching
  cacheTtlMinutes: 60 * 24 // 24h
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") callback(changes);
  });
}
