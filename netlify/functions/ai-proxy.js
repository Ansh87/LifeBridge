// LifeBridge AI, Gemini proxy (serverless)
//
// GEMINI_API_KEY is read from the Netlify environment at runtime and never
// leaves the server. It must never appear in any file in this repository.
//
// The model chain guards against Gemini model deprecations, which happen often
// enough that a single hardcoded model will eventually break a live demo.
// Ordered capable first, then progressively cheaper and higher quota, so a free
// tier limit degrades instead of failing outright. A model ID that no longer
// exists simply returns 404 and the loop moves on, so a retired entry is
// survivable, but it still costs a round trip. Keep this list current.
//
// Model status:
//   https://ai.google.dev/gemini-api/docs/models
//   https://ai.google.dev/gemini-api/docs/deprecations

const MODELS = [
  "gemini-3.7-flash",       // current recommended default
  "gemini-3.5-flash-lite",  // free tier friendly
  "gemini-2.5-flash",       // proven, still active
  "gemini-2.5-flash-lite",  // free tier friendly, last resort
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const key = process.env.GEMINI_API_KEY;

  // ---- health check -------------------------------------------------------
  // Open the function URL in a browser to see whether the key is actually set
  // on this deploy. Reports a boolean only, never the key and never a prefix.
  // This is the fastest way to tell "key missing" apart from "quota exhausted",
  // which otherwise look identical from the client.
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        service: "lifebridge-ai-proxy",
        configured: !!key,
        keyLength: key ? key.length : 0,
        models: MODELS,
        hint: key
          ? "Key is set. If the planner still fails it is a quota or model problem. POST and read the attempts array."
          : "GEMINI_API_KEY is NOT set on this deploy. Netlify, Site configuration, Environment variables.",
      }),
    };
  }

  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!key)
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "AI is not configured.", reason: "GEMINI_API_KEY missing" }),
    };

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

  const attempts = [];      // per model outcome, returned if everything fails
  const dead = new Set();   // models that returned 404, not worth a second pass

  // Two passes over the chain. On a rate limit (429 or 503) we back off briefly
  // and retry, so a transient free tier limit does not reach someone in crisis
  // as an "offline" fallback.
  for (let pass = 0; pass < 2; pass++) {
    for (const model of MODELS) {
      if (dead.has(model)) continue;
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );

        if (!r.ok) {
          let detail = "";
          try {
            const err = await r.json();
            detail = (err && err.error && err.error.message) || "";
          } catch {}

          attempts.push({ model, status: r.status, detail: String(detail).slice(0, 200) });

          // 404 means the model is retired or unavailable to this key, and 400
          // usually means the request shape is wrong for it. Neither will
          // succeed on a second pass, so skip rather than pay for it again.
          if (r.status === 404 || r.status === 400) dead.add(model);

          if ((r.status === 429 || r.status === 503) && pass === 0) await sleep(900);
          continue;
        }

        const data = await r.json();
        const cand = data && data.candidates && data.candidates[0];
        const text =
          (cand && cand.content && cand.content.parts &&
            cand.content.parts.map((p) => p.text).join("")) || "";

        if (!text) {
          attempts.push({
            model,
            status: 200,
            detail: "no content (" + ((cand && cand.finishReason) || "empty") + ")",
          });
          continue;
        }

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ text, model }) };
      } catch (e) {
        attempts.push({ model, status: 0, detail: String(e.message).slice(0, 200) });
      }
    }
    if (pass === 0) await sleep(600);
  }

  // Everything failed. Return the per model detail so the browser console can
  // say why, instead of only "unavailable". The difference between a bad key,
  // an exhausted quota and a retired model matters a lot when debugging.
  const allQuota = attempts.length > 0 && attempts.every((a) => a.status === 429);
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({
      error: allQuota
        ? "AI is rate limited right now. The free tier quota is exhausted and resets on a rolling window."
        : "AI is temporarily unavailable.",
      attempts,
    }),
  };
};
