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
    if (req.method === "POST" && req.body.step === "discover") {
      const { sessionCookie } = req.body;
      const pageRes = await fetch(LOGIN_PAGE_URL, { headers: { Cookie: sessionCookie || "" } });
      const html = await pageRes.text();
      const links = discoverLinks(html);
      return res.status(200).json({ links });
    }

    if (req.method === "POST" && req.body.step === "fetchPage") {
      const { sessionCookie, path } = req.body;
      const url = path.startsWith("http") ? path : BASE + path;
      const pageRes = await fetch(url, { headers: { Cookie: sessionCookie || "" } });
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

      return res.status(200).json({
        sessionCookie: cookie,
        captchaImage: `data:${contentType};base64,${captchaBase64}`,
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
      for (let i = 1; i <= 20; i++) candidates.push(`id=${i}`);
      for (let i = 1; i <= 15; i++) candidates.push(`rid=${i}`);

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

    res.status(400).json({ error: "Unknown request." });
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
};
