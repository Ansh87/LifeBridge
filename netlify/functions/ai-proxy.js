// LifeBridge AI — Gemini proxy (serverless)
// Key stored as GEMINI_API_KEY in Netlify environment variables.
// 3-model fallback chain guards against Gemini model deprecations.

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite-preview-06-17",
  "gemini-2.5-pro",
];

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const key = process.env.GEMINI_API_KEY;
  if (!key)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "AI is not configured." }) };

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad request." }) };
  }

  const { prompt, system, json } = payload;
  if (!prompt)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing prompt." }) };

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 2048,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  let lastErr = "";
  // Two passes over the model chain. On a rate limit (429/503) we briefly back
  // off and retry before giving up, so a transient free-tier limit does not
  // surface as an "offline" fallback to the user.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const model of MODELS) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        if (!r.ok) {
          lastErr = `Model ${model} returned ${r.status}`;
          // rate limited or overloaded — worth a short backoff + retry
          if ((r.status === 429 || r.status === 503) && attempt === 0) {
            await sleep(900);
          }
          continue; // try next model in the chain
        }
        const data = await r.json();
        const text =
          data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (!text) {
          lastErr = `Model ${model} returned empty content`;
          continue;
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ text, model }) };
      } catch (e) {
        lastErr = `Model ${model} error: ${e.message}`;
      }
    }
    if (attempt === 0) await sleep(600); // pause between full passes
  }

  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: "AI is temporarily unavailable. " + lastErr }),
  };
};
