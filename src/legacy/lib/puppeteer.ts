const puppeteer = require("puppeteer");

// Simple sample mock data (use while scraping is flaky)
const SAMPLE_MOCK = [
  { mmsi: "636015597", name: "Demo Vessel A", lat: 6.45, lon: 3.40, status: "underway" },
  { mmsi: "636015598", name: "Demo Vessel B", lat: 6.50, lon: 3.35, status: "at_anchor" }
];

const scrapeJsonFromResponse = async (options = {}, cb) => {
  // Quick mock short-circuit (env OR option)
  const useMock = process.env.USE_MOCK === "true" || options.useMock === true;
  if (useMock) {
    console.log("Using MOCK vessel data (USE_MOCK=true).");
    return cb(SAMPLE_MOCK);
  }

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "x-requested-with": "XMLHttpRequest",
      referer: options.referer,
      ...options.extraHeaders,
    });

    page.on("request", (interceptedRequest) => {
      console.log("A request was started: ", interceptedRequest.url());
    });

    // keep fallback requestfinished behavior (non-blocking)
    page.on("requestfinished", async (request) => {
      try {
        const resUrl = request.url();
        if (options.responseSelector && resUrl.indexOf(options.responseSelector) !== -1) {
          const response = request.response();
          if (!response) return;
          try {
            const json = await response.json();
            return cb(json);
          } catch (err) {
            // ignore: will attempt DOM extraction below
          }
        }
      } catch (err) {
        console.error("requestfinished handler error:", err && err.message ? err.message : err);
      }
    });

    // Browser fingerprinting
    page.setViewport({ height: 1302, width: 2458 });
    page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "de-DE"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    });

    // Load page
    await page.goto(options.url, { waitUntil: "networkidle0", timeout: 60000 });

    // === Option B: DOM extraction (generic) ===
    // This tries to extract table rows or list items into vessel objects.
    const extracted = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      if (rows.length > 1) {
        // assume first row is header -> map remaining
        const data = rows.slice(1).map((tr) => {
          const cells = Array.from(tr.querySelectorAll("td")).map((c) => c.textContent && c.textContent.trim());
          // heuristic mapping: [name, flag, port, lat, lon, status] - adapt later
          return {
            rawCells: cells,
            name: cells[0] || null,
            flag: cells[1] || null,
            current_port: cells[2] || null,
            lat: parseFloat(cells[3]) || null,
            lon: parseFloat(cells[4]) || null,
            status: cells[5] || null,
          };
        });
        return data;
      }

      // Fallback: look for list items or JSON blobs in the page
      const items = Array.from(document.querySelectorAll("li")).map((li) => li.textContent && li.textContent.trim());
      if (items.length) {
        return items.map((txt) => ({ raw: txt }));
      }

      // No structured data found
      return null;
    });

    if (extracted && extracted.length) {
      console.log("DOM extraction returned items:", extracted.length);
      return cb(extracted);
    }

    // If DOM extraction failed, attempt to find embedded JSON in full page HTML
    const html = await page.content();
    const jsonMatch = html.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch && jsonMatch[0]) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return cb(parsed);
      } catch (err) {
        console.warn("Found JSON-like content but parsing failed:", err.message);
      }
    }

    // Nothing useful found
    console.warn("No vessel data extracted from DOM or embedded JSON.");
    return cb(null);
  } catch (err) {
    console.error("Scrape error:", err && err.message ? err.message : err);
    return cb(null);
  } finally
