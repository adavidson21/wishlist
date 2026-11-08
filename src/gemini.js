// Gemini helper (used by photo search). Copied from personal-tools.

// Calls Gemini for structured JSON. Retries once on temporary errors.
// Returns { data, grounding } or { error: Response, status }. `tools` turns on built-in tools such as
// [{ google_search: {} }]; `grounding` is then the response's groundingMetadata (may be empty).
export async function callGemini(env, system, parts, schema, timeoutMs, model = env.GEMINI_MODEL || "gemini-3.5-flash-lite", tools = null) {
  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    ...(tools ? { tools } : {}),
    generationConfig: { responseMimeType: "application/json", responseSchema: schema },
  });
  let apiRes, data;
  for (let attempt = 0; attempt < 2; attempt++) {
    apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      }
    ).catch((err) => ({ ok: false, status: 504, json: async () => ({ error: { message: String(err) } }) }));
    data = await apiRes.json().catch(() => ({}));
    if (apiRes.ok || ![500, 503, 504].includes(apiRes.status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!apiRes.ok) {
    const msg = data?.error?.message || `Gemini error ${apiRes.status}`;
    const friendly =
      apiRes.status === 429 && /limit:\s*0\b/i.test(msg) ? "This AI model isn't included in your Gemini key's free tier. Turn on billing or switch models."
        : apiRes.status === 429 ? "Hit the usage limit. Wait a minute and try again."
        : apiRes.status === 503 || apiRes.status === 504 ? "The AI is busy or slow right now. Try again in a moment."
        : "The AI request failed.";
    return { error: json({ error: friendly, detail: `${apiRes.status}: ${msg}` }, 502), status: apiRes.status };
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

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

