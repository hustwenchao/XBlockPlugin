// Service worker — handles LLM API calls so the API key never lives in the page.

const SYSTEM_PROMPT = `你是 X (Twitter) 的严格内容审核助手。判断"回复"是否为垃圾。
你会同时拿到三个字段：用户昵称、@用户名、回复正文。任何一个字段命中以下规则都判为 spam=true。

垃圾 (spam=true) 类型：
1. 广告 / 推广 / 拉粉 / 引流 / 加联系方式（微信、QQ、Telegram、私信等）
2. 色情、约炮、招嫖、卖片、引流到其他平台。常见特征（昵称里尤其常见）：
   - "线下资源"、"同城约爱"、"同城炮友"、"看简介"、"同步更新"、"1-5线"、"出资源"、"卖片"
   - "刚分手"、"想被爱"、"寂寞"、"想找人陪"、"小哥哥/小姐姐"、"线下"、"出"、"福利"、"私"
   - 带可疑英数代号：如 "13dF"、"V+"、"tg@xxx"、"加v"、奇怪 ID
3. 纯符号 / 纯 emoji / emoji 堆砌且无实质内容（如 "N 🎌 💰 🔥 🌸 🌂"、"🔥🔥🔥"、"....."）
4. 与原帖完全无关的灌水、复读、刷屏
5. 明显的引战、人身攻击、仇恨言论
6. 钓鱼链接、空投、赠送、免费领、转账、虚假抽奖
7. 火星文、字符插入正常字以绕过审核（如 "约 泡"、"加 v"）

正常 (spam=false)：
- 围绕原帖话题的真实评论、提问、玩梗、抬杠、表达情绪（含 1~3 个 emoji 也算正常）
- "哈哈"、"赞"、"+1"、"😂😂" 等短回复，只要不属于上面 1-7 类，就算正常
- 普通用户名/昵称（含 emoji、数字后缀、火星文风格）只要不带上述招嫖/引流关键词，就算正常

判定原则：
- 信息量 ≈ 0 且 emoji/符号占比高 → spam
- 昵称命中色情/引流关键词 → spam（即使正文看起来正常，也是惯犯小号）
- 任何拉客、引流、暗示色情、求关注私信 → spam（即使写得隐晦）
- 拿不准时倾向 spam=false（避免误杀正常用户）

只输出严格 JSON，不要任何额外文字、不要 Markdown 代码块：
{"spam": true|false, "reason": "中文<=15字，说明命中类型与字段（如 昵称/正文）"}`;

async function callLLM({ baseUrl, apiKey, model, text, displayName, handle }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const userPayload =
    `用户昵称: ${displayName || "(空)"}\n` +
    `@用户名: ${handle || "(空)"}\n` +
    `回复正文: ${text || "(空)"}`;
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPayload }
    ],
    response_format: { type: "json_object" }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Tolerate models that wrap JSON in code fences despite response_format.
    const m = content.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { spam: false, reason: "" };
  }
  return {
    spam: !!parsed.spam,
    reason: String(parsed.reason || "").slice(0, 50)
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "llm-classify") return false;

  (async () => {
    try {
      const cfg = await chrome.storage.sync.get([
        "llmEnabled", "llmBaseUrl", "llmApiKey", "llmModel"
      ]);
      if (!cfg.llmEnabled || !cfg.llmApiKey) {
        sendResponse({ ok: false, error: "LLM disabled or missing key" });
        return;
      }
      const result = await callLLM({
        baseUrl: cfg.llmBaseUrl || "https://api.openai.com/v1",
        apiKey: cfg.llmApiKey,
        model: cfg.llmModel || "gpt-4o-mini",
        text: msg.text,
        displayName: msg.displayName,
        handle: msg.handle
      });
      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // keep the message channel open for async sendResponse
});

// Convenience: also expose a "test" endpoint used by the options page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "llm-test") return false;
  (async () => {
    try {
      const result = await callLLM({
        baseUrl: msg.baseUrl,
        apiKey: msg.apiKey,
        model: msg.model,
        text: msg.text || "关注我，私信送福利！",
        displayName: msg.displayName || "线下资源1-5线同步更新看简介",
        handle: msg.handle || "@spam_test_001"
      });
      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
