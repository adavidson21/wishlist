// Gemini helper (used by photo search). Copied from personal-tools.
import { geminiAllowed } from "./limits.js";

// Token savers sent with every call. If the model rejects them (400), the call is retried once without them.
// - mediaResolution MEDIUM: about half the image tokens of the default, still sharp enough to read labels.
// - thinkingLevel low: thinking is billed as output tokens, the priciest kind.
const SAVERS = {
  mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
  thinkingConfig: { thinkingLevel: "low" },
};

// Waits allowed for a per-minute rate limit (429), in ms. Kept short so the person isn't stuck waiting.
const RATE_LIMIT_WAITS = [4000, 10000];
const MAX_WAIT = 20000;

// Reads a 429's details: which quota ran out and how long Google says to wait.
export function quotaInfo(data) {
  const details = Array.isArray(data?.error?.details) ? data.error.details : [];
  const msg = String(data?.error?.message || "");
  const ids = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations : []))
    .map((v) => `${v?.quotaId || ""} ${v?.quotaMetric || ""}`).join(" ");
  const delay = details.find((d) => d?.retryDelay)?.retryDelay || msg.match(/retry in ([\d.]+)s/i)?.[1];
  const waitMs = delay ? Math.ceil(parseFloat(delay) * 1000) : null;
  return {
    notInPlan: /limit:\s*0\b/i.test(msg),
    daily: /PerDay/i.test(ids) || /per day/i.test(msg),
    search: /search|grounding/i.test(ids + " " + msg),
    waitMs,
  };
}

// Calls Gemini for structured JSON.
// Retries temporary errors (500/503/504) once, and per-minute rate limits (429) up to twice with a wait.
// Returns { data, grounding } or { error: Response, status, quota }. `tools` turns on built-in tools such as
// [{ google_search: {} }]; `grounding` is then the response's groundingMetadata (may be empty).
export async function callGemini(env, system, parts, schema, timeoutMs, model = env.GEMINI_MODEL || "gemini-3.5-flash-lite", tools = null) {
  // Whole-app daily cap (GEMINI_DAILY_CAP), so nobody can run up the bill. Treated like Google's own daily limit.
  if (!(await geminiAllowed(env))) {
    console.log("Gemini daily cap reached (GEMINI_DAILY_CAP)");
    return { error: json({ error: "The AI hit today's limit for Hints. It resets tomorrow. You can still type things in." }, 429), status: 429, quota: { daily: true } };
  }
  const makeBody = (savers) => JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    ...(tools ? { tools } : {}),
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, ...(savers ? SAVERS : {}) },
  });
  let savers = true, serverRetries = 1, rateWaits = 0;
  let apiRes, data, quota = null;
  for (;;) {
    apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: makeBody(savers),
        signal: AbortSignal.timeout(timeoutMs),
      }
    ).catch((err) => ({ ok: false, status: 504, json: async () => ({ error: { message: String(err) } }) }));
    data = await apiRes.json().catch(() => ({}));
    if (apiRes.ok) break;
    if (apiRes.status === 400 && savers) { savers = false; continue; }
    if ([500, 503, 504].includes(apiRes.status) && serverRetries-- > 0) {
      await sleep(1500);
      continue;
    }
    if (apiRes.status === 429) {
      quota = quotaInfo(data);
      // Daily limits and "not in your plan" won't clear by waiting.
      if (!quota.daily && !quota.notInPlan && rateWaits < RATE_LIMIT_WAITS.length) {
        await sleep(Math.min(MAX_WAIT, Math.max(quota.waitMs || 0, RATE_LIMIT_WAITS[rateWaits++])));
        continue;
      }
    }
    break;
  }
  if (!apiRes.ok) {
    const msg = data?.error?.message || `Gemini error ${apiRes.status}`;
    console.log(`Gemini ${model} ${tools ? "with search " : ""}failed: ${apiRes.status} ${msg}`);
    const friendly =
      apiRes.status === 429 && quota?.notInPlan ? "Photo search isn't included in the free Gemini plan for this model. Turn on billing or switch models."
        : apiRes.status === 429 && quota?.daily ? "Photo search hit today's limit. It resets overnight (about 3am Eastern)."
        : apiRes.status === 429 ? "Photo search is getting a lot of use right now. Wait a minute and try again."
        : apiRes.status === 503 || apiRes.status === 504 ? "The AI is busy or slow right now. Try again in a moment."
        : "The AI request failed.";
    return { error: json({ error: friendly, detail: `${apiRes.status}: ${msg}` }, 502), status: apiRes.status, quota };
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  try {
    return { data: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")), grounding: data?.candidates?.[0]?.groundingMetadata || {} };
  } catch {
    return { error: json({ error: "The AI returned something unexpected. Try again.", detail: text.slice(0, 500) }, 502) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
