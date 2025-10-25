const puppeteer = require("puppeteer");

/**
 * scrapeJsonFromResponse(options, cb)
 * options: {
 *   url: string,
 *   referer?: string,
 *   extraHeaders?: object,
 *   responseSelector?: string, // used by original requestfinished approach
 *   useDom?: boolean,          // if true, use DOM extraction after page.goto
 *   domRowSelector?: string,   // CSS selector for rows to extract (for useDom)
 *   domFieldMap?: object,      // map of fieldName -> selector relative to row (for useDom)
 *   useMock?: boolean          // if true, return sample mock JSON immediately
 * }
 */
const scrapeJsonFromResponse = async (options, cb) => {
  // Quick mock mode (Option A)
  if (options && options.useMock) {
    const mock = [
      { mmsi: "635000001", name: "MV DEMO ONE", lat: 6.45, lon: 3.39, status: "Underway" },
      { mmsi: "635000002", name: "MV DEMO TWO", lat: 6.48, lon: 3.35, status: "At Anchor" }
    ];
    console.log("Returning mock vessel data (useMock=true)");
    return cb(mock);
  }

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

    // Logging requests (helpful for debugging)
    page.on("request", (interceptedRequest) => {
      const reqUrl = interceptedRequest.url();
      console.log("A request was started: ", reqUrl);
    });

    // --- Option B: DOM extraction after page renders ---
    if (options && options.useDom) {
      // Set user agent / viewport to reduce bot detection
      page.setViewport({ height: 1302, width: 2458 });
      page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36"
      );
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "de-DE"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      });

      console.log("Navigating to:", options.url);
      await page.goto(options.url, { waitUntil: "networkidle2", timeout: 30000 });

      try {
        // Default selectors (you can override via options.domRowSelector / domFieldMap)
        const rowSel = options.domRowSelector || "table tr";
        const fieldMap = options.domFieldMap || {
          mmsi: "td:nth-child(1)",
          name: "td:nth-child(2)",
          lat: "td[data-lat]",
          lon: "td[data-lon]",
          status: "td.status"
        };

        // Extract rows -> objects
        const data = await page.evaluate((rowSelInner, fieldMapInner) => {
          const rows = Array.from(document.querySelectorAll(rowSelInner) || []);
          const out = [];
          for (const r of rows) {
            try {
              const obj = {};
              for (const key of Object.keys(fieldMapInner)) {
                const sel = fieldMapInner[key];
                if (!sel) { obj[key] = null; continue; }
                const el = r.querySelector(sel);
                if (!el) {
                  // fallback: look for a data-* attribute with the key
                  const attr = r.getAttribute(`data-${key}`);
                  obj[key] = attr !== null ? attr : null;
                } else {
                  obj[key] = el.textContent ? el.textContent.trim() : null;
                }
              }
              // Basic sanity: require at least one identifying field
              if (obj.mmsi || obj.name) out.push(obj);
            } catch (e) {
              // skip malformed row
            }
          }
          return out;
        }, rowSel, fieldMap);

        console.log("DOM extraction returned rows:", (data && data.length) || 0);
        await browser.close();
        return cb(data);
      } catch (domErr) {
        console.error("DOM extraction failed:", domErr && domErr.message ? domErr.message : domErr);
        // fallthrough to the requestfinished JSON handler below as a fallback
      }
    }

    // --- Original approach: intercept requestfinished and try JSON/text ---
    page.on("requestfinished", async (request) => {
      try {
        const resUrl = request.url();
        if (!options.responseSelector || resUrl.indexOf(options.responseSelector) === -1) return;
        const response = request.response();
        if (!response) {
          console.warn("requestfinished: response is undefined for", resUrl);
          return;
        }
        console.log("A response was received: ", await response.url());

        // Try JSON first
        try {
          const json = await response.json();
          return cb(json
