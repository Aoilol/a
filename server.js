// server.js
// Render.com'a deploy edilecek Node.js proxy
// Roblox → bu sunucu → Groq/OpenRouter/Gemini + Hugging Face

const https = require("https");
const http  = require("http");

const PORT = process.env.PORT || 3000;

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET") {
    res.end(JSON.stringify({ status: "proxy calisiyor" }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Sadece POST" }));
    return;
  }

  let rawBody = "";
  req.on("data", (chunk) => (rawBody += chunk));
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Gecersiz JSON" }));
      return;
    }

    const { provider, apiKey, model, systemPrompt, userPrompt } = body;

    const forcedSystem =
      (systemPrompt || "") +
      "\n\nKESIN KURAL: Sadece JSON don. Ilk karakter { son karakter } olmali. Baska hicbir sey yazma.";

    try {
      let resultText = null;

      if (provider === "groq" || provider === "openrouter") {
        const hostname = provider === "groq" ? "api.groq.com" : "openrouter.ai";
        const path = provider === "groq"
          ? "/openai/v1/chat/completions"
          : "/api/v1/chat/completions";

        const result = await httpsPost(
          hostname,
          path,
          { Authorization: "Bearer " + apiKey },
          {
            model: model || "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: forcedSystem },
              { role: "user",   content: userPrompt },
            ],
            temperature: 0.5,
            max_tokens: 250,
            response_format: { type: "json_object" },
          }
        );

        if (result.status !== 200) {
          res.end(JSON.stringify({
            ok: false,
            error: provider + " HTTP " + result.status + ": " + JSON.stringify(result.body).slice(0, 200),
          }));
          return;
        }

        resultText = result.body?.choices?.[0]?.message?.content ?? null;

      } else if (provider === "gemini") {
        const result = await httpsPost(
          "generativelanguage.googleapis.com",
          `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          {},
          {
            contents: [{
              parts: [{ text: forcedSystem + "\n\nOyun Durumu:\n" + userPrompt }],
            }],
            generationConfig: {
              temperature: 0.5,
              maxOutputTokens: 250,
              responseMimeType: "application/json",
            },
          }
        );

        if (result.status !== 200) {
          res.end(JSON.stringify({
            ok: false,
            error: "Gemini HTTP " + result.status + ": " + JSON.stringify(result.body).slice(0, 200),
          }));
          return;
        }

        resultText = result.body?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

      } else if (provider === "huggingface") {
        const hfModel = model || "mistralai/Mistral-7B-Instruct-v0.3";
        const result = await httpsPost(
          "api-inference.huggingface.co",
          `/models/${hfModel}`,
          { Authorization: "Bearer " + apiKey },
          {
            inputs: forcedSystem + "\n\n" + userPrompt + "\nKarar JSON:",
            parameters: {
              max_new_tokens: 150,
              temperature: 0.5,
              return_full_text: false,
              stop: ["</s>"]
            }
          }
        );

        if (result.status !== 200) {
          res.end(JSON.stringify({
            ok: false,
            error: "HuggingFace HTTP " + result.status + ": " + JSON.stringify(result.body).slice(0, 200),
          }));
          return;
        }

        const hfData = result.body;
        if (Array.isArray(hfData) && hfData.length > 0 && hfData[0].generated_text) {
          resultText = hfData[0].generated_text;
        } else {
          res.end(JSON.stringify({ ok: false, error: "Hugging Face model metin döndürmedi" }));
          return;
        }

      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "Bilinmeyen provider: " + provider }));
        return;
      }

      if (!resultText) {
        res.end(JSON.stringify({ ok: false, error: "AI bos yanit dondu" }));
        return;
      }

      let cleaned = resultText.trim().replace(/```json/g, "").replace(/```/g, "").trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        res.end(JSON.stringify({ ok: false, error: "AI JSON dondurmedi: " + cleaned.slice(0, 100) }));
        return;
      }

      res.end(JSON.stringify({ ok: true, text: JSON.stringify(parsed) }));

    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: "Sunucu hatasi: " + err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log("Proxy sunucu calisiyor, port:", PORT);
});
