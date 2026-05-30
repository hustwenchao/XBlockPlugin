import { getSettings, setSettings, DEFAULT_SETTINGS } from "../shared/settings.js";

const $ = id => document.getElementById(id);

const FIELDS = [
  "enabled", "keywordEnabled", "llmEnabled", "showReason",
  "collapseMode", "llmBaseUrl", "llmApiKey", "llmModel", "theme"
];

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

async function load() {
  const s = await getSettings();
  $("enabled").checked = s.enabled;
  $("keywordEnabled").checked = s.keywordEnabled;
  $("llmEnabled").checked = s.llmEnabled;
  $("showReason").checked = s.showReason;
  $("collapseMode").value = s.collapseMode;
  $("theme").value = s.theme || "system";
  applyTheme($("theme").value);
  $("llmBaseUrl").value = s.llmBaseUrl;
  $("llmApiKey").value = s.llmApiKey;
  $("llmModel").value = s.llmModel;
  $("keywords").value = (s.keywords || []).join("\n");
}

async function save() {
  const keywords = $("keywords").value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const patch = {
    enabled: $("enabled").checked,
    keywordEnabled: $("keywordEnabled").checked,
    llmEnabled: $("llmEnabled").checked,
    showReason: $("showReason").checked,
    collapseMode: $("collapseMode").value,
    theme: $("theme").value,
    llmBaseUrl: $("llmBaseUrl").value.trim() || DEFAULT_SETTINGS.llmBaseUrl,
    llmApiKey: $("llmApiKey").value.trim(),
    llmModel: $("llmModel").value.trim() || DEFAULT_SETTINGS.llmModel,
    keywords
  };
  await setSettings(patch);

  const status = $("saveStatus");
  status.textContent = "已保存 ✓";
  status.className = "result ok";
  setTimeout(() => { status.textContent = ""; status.className = "result"; }, 2000);
}

async function testLLM() {
  const result = $("testResult");
  result.textContent = "测试中...";
  result.className = "result";

  const resp = await chrome.runtime.sendMessage({
    type: "llm-test",
    baseUrl: $("llmBaseUrl").value.trim() || DEFAULT_SETTINGS.llmBaseUrl,
    apiKey: $("llmApiKey").value.trim(),
    model: $("llmModel").value.trim() || DEFAULT_SETTINGS.llmModel,
    text: "关注我私信送福利！加微信 abc123"
  });

  if (resp?.ok) {
    result.textContent = `连通 ✓  spam=${resp.spam}  reason=${resp.reason || "(无)"}`;
    result.className = "result ok";
  } else {
    result.textContent = `失败: ${resp?.error || "未知错误"}`;
    result.className = "result err";
  }
}

$("saveBtn").addEventListener("click", save);
$("testBtn").addEventListener("click", testLLM);
$("theme").addEventListener("change", e => applyTheme(e.target.value));

load();
