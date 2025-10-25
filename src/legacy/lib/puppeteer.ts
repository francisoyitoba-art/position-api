const puppeteer = require("puppeteer");

const scrapeJsonFromResponse = async (options, cb) => {
  const browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
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
            console.error("Failed to read response text:", textErr && textErr.message ? textErr.message : textErr);
            return cb(null);
          }
        }
      } catch (err) {
        console.error("Error handling finished request:", err && err.message ? err.message : err);
        return cb(null);
      }
    });

    // Mock real desktop chrome
    await page.setViewport({ height: 1302, width: 2458 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36"
    );

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "de-DE"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    });

    await page.goto(options.url, { waitUntil: "networkidle0" });

    // Additional robust DOM-scraping fallback: try to extract table rows if JSON wasn't produced
    try {
      // Example: attempt to extract a generic table of rows if page contains it
      const tableData = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("table tr"));
        if (!rows.length) return null;
        return rows.slice(1).map(r => {
          const cols = Array.from(r.querySelectorAll("td")).map(c => c.innerText.trim());
          return { cols };
        });
      });
      if (tableData) {
        // If we got table rows, return them as a fallback structure
        cb({ table: tableData });
      }
    } catch (domErr) {
      // swallow DOM extraction errors (we already attempted network-based extraction earlier)
      console.warn("DOM extraction attempt failed:", domErr && domErr.message ? domErr.message : domErr);
    }

  } catch (outerErr) {
    console.error("Puppeteer wrapper failure:", outerErr && outerErr.message ? outerErr.message : outerErr);
    cb(null);
  } finally {
    try {
      await browser.close();
    } catch (closeErr) {
      console.warn("Failed to close browser:", closeErr && closeErr.message ? closeErr.message : closeErr);
    }
  }
};

module.exports = {
  fetch: scrapeJsonFromResponse,
};
