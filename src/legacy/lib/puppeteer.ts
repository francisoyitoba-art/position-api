const puppeteer = require("puppeteer");

const scrapeJsonFromResponse = async (options, cb) => {
  const browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "x-requested-with": "XMLHttpRequest",
    referer: options.referer,
    ...options.extraHeaders,
  });

  page.on("request", (interceptedRequest) => {
    const reqUrl = interceptedRequest.url();
    console.log("A request was started: ", reqUrl);
  });

  page.on("requestfinished", async (request) => {
    try {
      const resUrl = request.url();
      if (resUrl.indexOf(options.responseSelector) === -1) return;

      const response = request.response();
      console.log("A response was received: ", await response.url());

      // Try JSON first (normal case)
      try {
        const json = await response.json();
        return cb(json);
      } catch (jsonErr) {
        // Not JSON — try to recover from text/HTML
        try {
          const text = await response.text();

          // Attempt to find a JSON object/array inside the HTML (simple heuristic)
          const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
          if (jsonMatch && jsonMatch[0]) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              return cb(parsed);
            } catch (parseErr) {
              console.error("Failed to parse extracted JSON:", parseErr.message);
            }
          }

          // If no JSON found, return the raw text so caller can inspect (or null)
          console.warn("Upstream returned non-JSON response; returning raw text.");
          return cb({ raw: text });
        } catch (textErr) {
          console.error("Failed to read response text:", textErr.message);
          return cb(null);
        }
      }
    } catch (err) {
      console.error("Error handling finished request:", err && err.message ? err.message : err);
      return cb(null);
    }
  });

  // Mock real desktop chrome
  page.setViewport({ height: 1302, width: 2458 });
  page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36"
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "de-DE"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });

  await page.goto(options.url, { waitUntil: "networkidle0" });

  await browser.close();
};

module.exports = {
  fetch: scrapeJsonFromResponse,
};
