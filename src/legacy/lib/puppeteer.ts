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
      console.log("A request was started:", reqUrl);
    });

    let handled = false;

    page.on("requestfinished", async (request) => {
      try {
        const resUrl = request.url();
        if (resUrl.indexOf(options.responseSelector) === -1) return;

        const response = request.response();
        console.log("A response was received:", await response.url());

        // Try JSON first
        try {
          const json = await response.json();
          handled = true;
          return cb({ ok: true, source: "json", data: json });
        } catch {
          // Try HTML / text next
          try {
            const text = await response.text();

            // Try to find embedded JSON
            const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
            if (jsonMatch && jsonMatch[0]) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                handled = true;
                return cb({ ok: true, source: "embedded_json", data: parsed });
              } catch (parseErr: any) {
                console.error("Failed to parse embedded JSON:", parseErr.message);
              }
            }

            // Return snippet for inspection
            const snippet = text ? text.slice(0, 2000) : "";
            handled = true;
            return cb({
              ok: false,
              reason: "upstream_non_json",
              upstreamUrl: await response.url(),
              snippetLength: snippet.length,
              snippet,
            });
          } catch (textErr: any) {
            console.error("Failed to read response text:", textErr.message);
            handled = true;
            return cb({ ok: false, reason: "read_text_failed" });
          }
        }
      } catch (err: any) {
        console.error("Error in requestfinished handler:", err.message);
        handled = true;
        return cb({ ok: false, reason: "handler_error", message: err.message });
      }
    });

    // Mock desktop Chrome
    await page.setViewport({ height: 1302, width: 2458 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36"
    );

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "de-DE"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    });

    await page.goto(options.url, { waitUntil: "networkidle0", timeout: 30000 }).catch((e: any) => {
      console.warn("page.goto warning:", e.message);
    });

    // Fallback: extract table rows if no JSON found
    if (!handled) {
      try {
        const tableData = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("table tr"));
          if (!rows.length) return null;
          return rows.slice(1).map((r) => {
            const cols = Array.from(r.querySelectorAll("td")).map((c) => c.innerText.trim());
            return { cols };
          });
        });
        if (tableData && tableData.length) {
          handled = true;
          return cb({ ok: true, source: "dom_table", data: tableData });
        }
      } catch (domErr: any) {
        console.warn("DOM extraction failed:", domErr.message);
      }
    }

    if (!handled) {
      return cb({ ok: false, reason: "no_data_extracted" });
    }
  } catch (outerErr: any) {
    console.error("Puppeteer wrapper failure:", outerErr.message);
    return cb({ ok: false, reason: "puppeteer_wrapper_failure", message: outerErr.message });
  } finally {
    try {
      await browser.close();
    } catch (closeErr: any) {
      console.warn("Failed to close browser:", closeErr.message);
    }
  }
};

module.exports = {
  fetch: scrapeJsonFromResponse,
};
