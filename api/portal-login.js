// api/portal-login.js
// Deploy on Vercel (free tier) as a serverless function.
// Handles: GET ?step=start  -> loads login page + captcha image, returns session cookie
//          POST step=login  -> submits credentials + captcha, returns session + result

const BASE = "https://student.srmap.edu.in";
const LOGIN_PAGE_URL = BASE + "/srmapstudentcorner/";
const CAPTCHA_URL = BASE + "/srmapstudentcorner/captchas";
const LOGIN_POST_URL = BASE + "/srmapstudentcorner/StudentLoginToPortal";

function extractCookie(setCookieHeader, existing) {
  // Keep it simple: merge new Set-Cookie values with any we already have.
  if (!setCookieHeader) return existing || "";
  const parts = setCookieHeader.split(",").map(c => c.split(";")[0].trim());
  const map = {};
  (existing || "").split(";").forEach(c => {
    const [k, v] = c.split("=");
    if (k && v) map[k.trim()] = v.trim();
  });
  parts.forEach(c => {
    const [k, v] = c.split("=");
    if (k && v) map[k.trim()] = v.trim();
  });
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractTables(html) {
  const stripTags = s => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const tables = [];
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRegex.exec(html))) {
    const tableHtml = tm[0];
    const rows = [];
    const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = rowRegex.exec(tableHtml))) {
      const rowHtml = rm[0];
      const cells = [];
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRegex.exec(rowHtml))) {
        cells.push(stripTags(cm[1]));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : "";
}

function extractBodyText(html) {
  // Strip script/style/nav/header/footer blocks, then pull remaining visible text.
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  // Prefer text from common "main content" containers if present, else the whole body.
  const bodyMatch = cleaned.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
  const scope = bodyMatch ? bodyMatch[1] : cleaned;
  const text = scope
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");
  return text.slice(0, 4000); // keep it bounded
}

function discoverLinks(html) {
  const stripTags = s => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const seen = new Set();
  const links = [];

  // Pass 1: normal <a href="..."> links, paired with their visible text.
  const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html))) {
    let href = m[1].trim();
    const label = stripTags(m[2]);
    if (!label) continue;
    if (href.startsWith("javascript:") || href.startsWith("mailto:") || (href.startsWith("http") && !href.includes("student.srmap.edu.in"))) continue;
    if (!href.startsWith("http")) {
      href = href.startsWith("/") ? BASE + href : BASE + "/srmapstudentcorner/" + href;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ label, url: href });
  }

  // Pass 2: menus that navigate via JavaScript (onclick="...") instead of plain href.
  // Look for any element with an onclick handler referencing a portal-style path,
  // and pull the nearest visible text as its label.
  const clickableRegex = /<a\s+[^>]*onclick\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = clickableRegex.exec(html))) {
    const onclickAttr = m[1];
    const label = stripTags(m[2]);
    if (!label) continue;
    const pathMatch = onclickAttr.match(/['"`](\/[A-Za-z0-9_\-\/\.]*srmapstudentcorner[A-Za-z0-9_\-\/\.]*|\/srmapstudentcorner\/[A-Za-z0-9_\-\/\.]+)['"`]/i)
      || onclickAttr.match(/['"`]([A-Za-z0-9_\-]+\.(?:aspx|jsp|php|do|action))['"`]/i);
    if (!pathMatch) continue;
    let href = pathMatch[1];
    if (!href.startsWith("http")) {
      href = href.startsWith("/") ? BASE + href : BASE + "/srmapstudentcorner/" + href;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ label, url: href });
  }

  // Pass 3: catch-all -- any quoted string anywhere in the page that looks like a
  // portal-relative path, in case navigation happens through inline JS variables
  // rather than href or onclick on the same tag.
  const rawPathRegex = /["'](\/srmapstudentcorner\/[A-Za-z0-9_\-\/\.]+)["']/gi;
  while ((m = rawPathRegex.exec(html))) {
    const href = BASE + m[1];
    if (seen.has(href)) continue;
    if (href.includes("captcha") || href.includes("StudentLoginToPortal") || href.includes(".css") || href.includes(".js") || href.includes(".png") || href.includes(".jpg")) continue;
    seen.add(href);
    const guessedLabel = m[1].split("/").filter(Boolean).pop().replace(/[-_]/g, " ");
    links.push({ label: guessedLabel, url: href });
  }

  return links;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
try {
  // searchExamDocuments block

  if (req.method === "POST" && req.body.step === "discover") {
    // existing discover code
  }

  if (req.method === "POST" && req.body.step === "fetchPage") {
    // existing fetchPage code
  }

  // start
  // login
  // probeReports
  // probeAssets
  // submitAttendanceCode

} catch (e) {
  // existing error handling
}
  const BASE_INTRANET = "https://intranet.srmap.edu.in";

  function cleanText(value) {
    return String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  function makeAbsoluteUrl(href, pageUrl) {
    try {
      return new URL(href, pageUrl).href;
    } catch {
      return "";
    }
  }

  function extractIntranetLinks(html, pageUrl) {
    const links = [];
    const seen = new Set();

    const regex =
      /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
      const href = makeAbsoluteUrl(match[1], pageUrl);
      const label = cleanText(match[2]);

      if (!href || !label) continue;

      try {
        const host = new URL(href).host;

        if (host !== new URL(BASE_INTRANET).host) {
          continue;
        }
      } catch {
        continue;
      }

      if (seen.has(href)) continue;

      seen.add(href);

      links.push({
        label,
        url: href
      });
    }

    return links;
  }

  function isPdf(link) {
    return /\.pdf(?:$|[?#])/i.test(link.url) ||
           /\.pdf\b/i.test(link.label);
  }

  function scoreResult(link) {
    const text =
      `${link.label} ${link.url}`.toLowerCase();

    let score = 0;

    if (
      courseCode &&
      text.includes(String(courseCode).toLowerCase())
    ) {
      score += 100;
    }

    if (
      examType &&
      text.includes(String(examType).toLowerCase())
    ) {
      score += 50;
    }

    if (
      year &&
      text.includes(String(year))
    ) {
      score += 30;
    }

    if (
      month &&
      text.includes(String(month).toLowerCase())
    ) {
      score += 20;
    }

    if (isPdf(link)) {
      score += 10;
    }

    return score;
  }

  // ----------------------------------------------------------
  // Parse missing values from the natural-language query
  // ----------------------------------------------------------

  let detectedCourse =
    String(courseCode || "").trim().toUpperCase();

  let detectedYear =
    String(year || "").trim();

  let detectedExamType =
    String(examType || "").trim();

  let detectedMonth =
    String(month || "").trim();

  if (!detectedCourse) {
    const courseMatch = String(query).match(
      /\b[A-Z]{2,6}\s*[-]?\s*\d{3,4}\b/i
    );

    if (courseMatch) {
      detectedCourse =
        courseMatch[0]
          .replace(/\s+/g, "")
          .toUpperCase();
    }
  }

  if (!detectedYear) {
    const yearMatch =
      String(query).match(/\b20\d{2}\b/);

    if (yearMatch) {
      detectedYear = yearMatch[0];
    }
  }

  if (!detectedExamType) {
    if (/mid[\s-]*term/i.test(query)) {
      detectedExamType = "Mid Term";
    } else if (/end[\s-]*term/i.test(query)) {
      detectedExamType = "End Term";
    }
  }

  if (!detectedMonth) {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];

    for (const m of months) {
      if (
        new RegExp(`\\b${m}\\b`, "i").test(query)
      ) {
        detectedMonth = m;
        break;
      }
    }
  }

  // ----------------------------------------------------------
  // Crawl the LIVE SRM INTRANET
  // ----------------------------------------------------------

  const startUrl = BASE_INTRANET + "/";

  const queue = [
    {
      url: startUrl,
      depth: 0,
      path: ["SRM Intranet"]
    }
  ];

  const visited = new Set();
  const results = [];

  const MAX_PAGES = 100;
  const MAX_DEPTH = 7;

  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES
  ) {
    // Prioritize examination/question-paper pages.
    queue.sort((a, b) => {
      const score = url => {
        const value = url.toLowerCase();

        let n = 0;

        if (value.includes("exam")) n += 30;
        if (value.includes("question")) n += 30;
        if (value.includes("paper")) n += 20;
        if (value.includes("document")) n += 20;
        if (value.includes("mid")) n += 10;
        if (value.includes("end")) n += 10;

        return n;
      };

      return score(b.url) - score(a.url);
    });

    const current = queue.shift();

    if (!current) continue;

    if (visited.has(current.url)) continue;

    if (current.depth > MAX_DEPTH) continue;

    visited.add(current.url);

    let response;

    try {
      response = await fetch(current.url, {
        headers: {
          Cookie: sessionCookie || "",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
    } catch (error) {
      continue;
    }

    if (!response.ok) {
      continue;
    }

    const html = await response.text();

    if (!html) continue;

    const links =
      extractIntranetLinks(
        html,
        current.url
      );

    for (const link of links) {

      // ------------------------------------------------------
      // PDF FOUND
      // ------------------------------------------------------

      if (isPdf(link)) {

        const score = scoreResult(link);

        const searchable =
          `${link.label} ${link.url}`.toLowerCase();

        const courseOK =
          !detectedCourse ||
          searchable.includes(
            detectedCourse.toLowerCase()
          );

        const examOK =
          !detectedExamType ||
          searchable.includes(
            detectedExamType.toLowerCase()
          );

        const yearOK =
          !detectedYear ||
          searchable.includes(
            detectedYear
          );

        if (
          courseOK &&
          examOK &&
          yearOK &&
          score > 0
        ) {
          results.push({
            title:
              link.label ||
              link.url.split("/").pop(),

            courseCode:
              detectedCourse || null,

            examType:
              detectedExamType || null,

            year:
              detectedYear || null,

            month:
              detectedMonth || null,

            folderPath:
              current.path.join(" / "),

            pdfUrl:
              link.url,

            source:
              "SRM Intranet Examination",

            score
          });
        }

        continue;
      }

      // ------------------------------------------------------
      // CONTINUE CRAWLING SRM INTRANET
      // ------------------------------------------------------

      if (current.depth < MAX_DEPTH) {
        try {
          const linkHost =
            new URL(link.url).host;

          const intranetHost =
            new URL(BASE_INTRANET).host;

          if (
            linkHost === intranetHost &&
            !visited.has(link.url)
          ) {
            queue.push({
              url: link.url,
              depth: current.depth + 1,
              path: [
                ...current.path,
                link.label
              ]
            });
          }
        } catch {
          // Ignore malformed links.
        }
      }
    }
  }

  // ----------------------------------------------------------
  // Remove duplicate PDFs
  // ----------------------------------------------------------

  const unique = new Map();

  for (const item of results) {
    if (!unique.has(item.pdfUrl)) {
      unique.set(item.pdfUrl, item);
    }
  }

  const finalResults =
    [...unique.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(item => {
        const copy = { ...item };
        delete copy.score;
        return copy;
      });

  return res.status(200).json({
    success: true,

    query,

    detected: {
      courseCode: detectedCourse || null,
      examType: detectedExamType || null,
      year: detectedYear || null,
      month: detectedMonth || null
    },

    pagesVisited:
      visited.size,

    results:
      finalResults
  });
}
  try {
    if (req.method === "POST" && req.body.step === "discover") {
      const { sessionCookie } = req.body;
      const pageRes = await fetch(LOGIN_PAGE_URL, { headers: { Cookie: sessionCookie || "" } });
      const html = await pageRes.text();
      const links = discoverLinks(html);
      return res.status(200).json({ links });
    }

    if (req.method === "POST" && req.body.step === "fetchPage") {
      const { sessionCookie, path, postBody } = req.body;
      const url = path.startsWith("http") ? path : BASE + path;
      const fetchOpts = { headers: { Cookie: sessionCookie || "" } };
      if (postBody) {
        fetchOpts.method = "POST";
        fetchOpts.headers["Content-Type"] = "application/x-www-form-urlencoded";
        fetchOpts.headers["X-Requested-With"] = "XMLHttpRequest";
        fetchOpts.headers["Referer"] = BASE + "/srmapstudentcorner/HRDSystem";
        fetchOpts.body = postBody;
      }
      const pageRes = await fetch(url, fetchOpts);
      const html = await pageRes.text();
      const loggedOut = html.toLowerCase().includes("application number / register number") || html.toLowerCase().includes('id="username"');
      if (loggedOut) {
        return res.status(401).json({ error: "Session expired -- please log in again." });
      }
      const tables = extractTables(html);
      const text = tables.length === 0 ? extractBodyText(html) : "";
      return res.status(200).json({ title: extractTitle(html), tables, text });
    }

    if (req.method === "GET" && req.query.step === "start") {
      // 1. Load the login page to establish a session cookie
      const pageRes = await fetch(LOGIN_PAGE_URL);
      let cookie = extractCookie(pageRes.headers.get("set-cookie"), "");

      // 2. Fetch the captcha image using that same session
      const captchaRes = await fetch(CAPTCHA_URL, { headers: { Cookie: cookie } });
      cookie = extractCookie(captchaRes.headers.get("set-cookie"), cookie);
      const captchaBuffer = await captchaRes.arrayBuffer();
      const captchaBase64 = Buffer.from(captchaBuffer).toString("base64");
      const contentType = captchaRes.headers.get("content-type") || "image/jpeg";

      // OCR.Space free API
let captchaText = '';

try {
  const form = new URLSearchParams();
  form.append('base64Image', `data:${contentType};base64,${captchaBase64}`);
  form.append('language', 'eng');

  const ocrRes = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      apikey: process.env.OCR_SPACE_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const ocrData = await ocrRes.json();

  captchaText =
    ocrData?.ParsedResults?.[0]?.ParsedText
      ?.replace(/[^a-zA-Z0-9]/g, '')
      ?.trim()
      ?.slice(0, 6) || '';
} catch (e) {
  captchaText = '';
}

return res.status(200).json({
  sessionCookie: cookie,
  captchaImage: `data:${contentType};base64,${captchaBase64}`,
  captchaText
});
    }

    if (req.method === "POST" && req.body.step === "login") {
      const { username, password, captcha, sessionCookie } = req.body;

      const form = new URLSearchParams({
        txtUserName: username,
        txtAuthKey: password,
        ccode: captcha,
      });

      const loginRes = await fetch(LOGIN_POST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: sessionCookie || "",
        },
        body: form.toString(),
        redirect: "manual",
      });

      const newCookie = extractCookie(loginRes.headers.get("set-cookie"), sessionCookie);
      const redirectLocation = loginRes.headers.get("location");
      const html = await loginRes.text();

      // Heuristics -- refine once we see a real failed vs successful response:
      const looksLikeFailure =
        html.toLowerCase().includes("invalid") ||
        html.toLowerCase().includes("incorrect") ||
        (loginRes.status >= 300 && loginRes.status < 400 && redirectLocation && redirectLocation.includes("StudentLoginToPortal"));

      if (looksLikeFailure) {
        return res.status(401).json({
          error: "Login didn't succeed -- wrong credentials/captcha, or the site's response format differs from what we expected.",
          debugStatus: loginRes.status,
          debugRedirect: redirectLocation || null,
        });
      }

      return res.status(200).json({
        sessionCookie: newCookie,
        redirectLocation: redirectLocation || null,
        message: "Login request completed. Next step: capture the URLs for your timetable/attendance/exam pages so we can fetch and parse them.",
      });
    }

    if (req.method === "POST" && req.body.step === "probeReports") {
      const { sessionCookie } = req.body;
      const REPORT_URL = BASE + "/srmapstudentcorner/students/report/studentreportresources.jsp";
      const candidates = [];
      for (let i = 1; i <= 25; i++) candidates.push(`ids=${i}`); // confirmed field name from real production code

      // Visit the dashboard first -- some portals only serve real AJAX content
      // after the session has "seen" the main page, same as a real browser would.
      try {
        await fetch(BASE + "/srmapstudentcorner/HRDSystem", { headers: { Cookie: sessionCookie || "" } });
      } catch (e) {
        // non-fatal -- continue probing even if this fails
      }

      const results = [];
      for (const body of candidates) {
        try {
          const r = await fetch(REPORT_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              "Referer": BASE + "/srmapstudentcorner/HRDSystem",
              Cookie: sessionCookie || "",
            },
            body,
          });
          const html = await r.text();
          const tables = extractTables(html);
          const text = tables.length === 0 ? extractBodyText(html) : "";
          const snippet = (tables.length ? tables[0].slice(0,2).map(row=>row.join(" | ")).join(" // ") : text).slice(0, 160);
          const isGenericFallback = snippet.toLowerCase().includes("welcome to srm university");
          if (snippet.trim() && !isGenericFallback) {
            results.push({ body, snippet, hasTables: tables.length > 0 });
          }
        } catch (e) {
          // skip failures silently, keep probing
        }
      }
      return res.status(200).json({ results });
    }

    if (req.method === "GET" && req.query.step === "probeAssets") {
      const candidateFiles = [
        "app.js", "main.js", "srmap.js", "srmapstudentcorner.js", "activity.js",
        "menu.js", "menus.js", "script.js", "scripts.js", "functions.js",
        "common.js", "portal.js", "student.js", "sidebar.js", "navigation.js",
        "custom1.js", "custom2.js", "site.js", "index.js", "global.js",
      ];
      const found = [];
      for (const file of candidateFiles) {
        const url = BASE + "/srmapstudentcorner/resources/js/" + file;
        try {
          const r = await fetch(url);
          if (r.status !== 200) continue;
          const js = await r.text();
          if (js.length < 20) continue; // likely an empty/error placeholder
          const hasReport = /studentreportresources/i.test(js);
          const hasActivity = /clsactivity/i.test(js);
          if (hasReport || hasActivity) {
            // pull a window of text around the first relevant match
            const idx = js.search(/studentreportresources|clsactivity/i);
            const snippet = js.slice(Math.max(0, idx - 100), idx + 500);
            found.push({ file, snippet });
          } else {
            found.push({ file, snippet: "(file exists, " + js.length + " bytes, no relevant match)" });
          }
        } catch (e) {
          // file doesn't exist or fetch failed -- skip
        }
      }
      return res.status(200).json({ found });
    }

    if (req.method === "POST" && req.body.step === "submitAttendanceCode") {
      const { sessionCookie, code } = req.body;
      if (!code) return res.status(400).json({ error: "Enter the attendance code first." });

      const SUBMIT_URL = BASE + "/srmapstudentcorner/students/transaction/studentattendanceresources.jsp";
      const payload = new URLSearchParams({
        acode: code,
        dynamiclatdata: "0",
        dynamiclonxdata: "0",
        ids: "1",
      });

      const response = await fetch(SUBMIT_URL, {
        method: "POST",
        body: payload.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": sessionCookie || "",
          "Referer": BASE + "/srmapstudentcorner/HRDSystem",
        },
      });

      const text = await response.text();
      let responseData;
      try {
        responseData = JSON.parse(text.trim());
      } catch {
        try {
          responseData = JSON.parse(text.replace(/<[^>]+>/g, "").trim());
        } catch {
          return res.status(200).json({ success: false, message: "Couldn't read the portal's response -- try again." });
        }
      }

      if (responseData.resultstatus === "1") {
        return res.status(200).json({ success: true, message: "Attendance captured successfully!" });
      } else if (typeof responseData.result === "string" && responseData.result.includes("Your Attendance captured al")) {
        return res.status(200).json({ success: true, message: "Attendance already captured for this class." });
      } else if (typeof responseData.result === "string" && responseData.result.includes("You have entered the Wrong Attendance")) {
        return res.status(200).json({ success: false, message: "Wrong attendance code -- double check and try again." });
      } else {
        return res.status(200).json({ success: false, message: "Couldn't submit -- the code may be incorrect or expired." });
      }
    }

    res.status(400).json({ error: "Unknown request." });
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
};
