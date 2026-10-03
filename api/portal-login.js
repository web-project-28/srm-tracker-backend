// api/portal-login.js
// Deploy on Vercel as a serverless function.
//
// Handles:
// GET  ?step=start
// POST step=login
// POST step=discover
// POST step=fetchPage
// POST step=probeReports
// GET  ?step=probeAssets
// POST step=submitAttendanceCode
//
// Supabase:
// Logs successful/failed login attempts to login_logs.
// IMPORTANT: SRM passwords are NEVER stored in Supabase.

const { createClient } = require("@supabase/supabase-js");

const BASE = "https://student.srmap.edu.in";
const LOGIN_PAGE_URL = BASE + "/srmapstudentcorner/";
const CAPTCHA_URL = BASE + "/srmapstudentcorner/captchas";
const LOGIN_POST_URL = BASE + "/srmapstudentcorner/StudentLoginToPortal";

// ---------------------------------------------------------
// SUPABASE
// ---------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------
// COOKIE HELPERS
// ---------------------------------------------------------

function extractCookie(setCookieHeader, existing) {
  if (!setCookieHeader) return existing || "";

  const parts = setCookieHeader
    .split(",")
    .map(c => c.split(";")[0].trim());

  const map = {};

  (existing || "").split(";").forEach(c => {
    const [k, v] = c.split("=");

    if (k && v) {
      map[k.trim()] = v.trim();
    }
  });

  parts.forEach(c => {
    const [k, v] = c.split("=");

    if (k && v) {
      map[k.trim()] = v.trim();
    }
  });

  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ---------------------------------------------------------
// SUPABASE LOGIN LOGGER
// ---------------------------------------------------------

async function logLogin({
  registrationNo,
  email = null,
  status,
  req,
  deviceId = null,
  deviceName = null,
  browser = null,
  operatingSystem = null,
  country = null,
  state = null,
  city = null
}) {
  try {
    const forwarded = req.headers["x-forwarded-for"];

    const ipAddress =
      (typeof forwarded === "string"
        ? forwarded.split(",")[0].trim()
        : null) ||
      req.socket?.remoteAddress ||
      null;

    const userAgent = req.headers["user-agent"] || null;

    const { error } = await supabase
      .from("login_logs")
      .insert({
        registration_no: registrationNo || null,
        email: email || null,

        ip_address: ipAddress,

        country: country || null,
        state: state || null,
        city: city || null,

        device_id: deviceId || null,
        device_name: deviceName || null,

        browser: browser || null,
        operating_system: operatingSystem || null,

        user_agent: userAgent,

        login_status: status,

        login_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      });

    if (error) {
      console.error(
        "SUPABASE LOGIN LOG ERROR:",
        error
      );
    }
  } catch (error) {
    // Logging should never break SRM login.
    console.error(
      "LOGIN LOGGING ERROR:",
      error
    );
  }
}

// ---------------------------------------------------------
// HTML TABLE PARSER
// ---------------------------------------------------------

function extractTables(html) {
  const stripTags = s =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();

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

      const cellRegex =
        /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

      let cm;

      while ((cm = cellRegex.exec(rowHtml))) {
        cells.push(stripTags(cm[1]));
      }

      if (cells.length) {
        rows.push(cells);
      }
    }

    if (rows.length) {
      tables.push(rows);
    }
  }

  return tables;
}

// ---------------------------------------------------------
// HTML TITLE
// ---------------------------------------------------------

function extractTitle(html) {
  const m = html.match(
    /<title>([\s\S]*?)<\/title>/i
  );

  return m ? m[1].trim() : "";
}

// ---------------------------------------------------------
// BODY TEXT
// ---------------------------------------------------------

function extractBodyText(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");

  const bodyMatch = cleaned.match(
    /<body[\s\S]*?>([\s\S]*?)<\/body>/i
  );

  const scope = bodyMatch
    ? bodyMatch[1]
    : cleaned;

  const text = scope
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");

  return text.slice(0, 4000);
}

// ---------------------------------------------------------
// DISCOVER LINKS
// ---------------------------------------------------------

function discoverLinks(html) {
  const stripTags = s =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();

  const seen = new Set();
  const links = [];

  // Pass 1: normal links

  const linkRegex =
    /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;

  while ((m = linkRegex.exec(html))) {
    let href = m[1].trim();

    const label = stripTags(m[2]);

    if (!label) continue;

    if (
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      (
        href.startsWith("http") &&
        !href.includes("student.srmap.edu.in")
      )
    ) {
      continue;
    }

    if (!href.startsWith("http")) {
      href = href.startsWith("/")
        ? BASE + href
        : BASE + "/srmapstudentcorner/" + href;
    }

    if (seen.has(href)) continue;

    seen.add(href);

    links.push({
      label,
      url: href
    });
  }

  // Pass 2: onclick links

  const clickableRegex =
    /<a\s+[^>]*onclick\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  while ((m = clickableRegex.exec(html))) {
    const onclickAttr = m[1];

    const label = stripTags(m[2]);

    if (!label) continue;

    const pathMatch =
      onclickAttr.match(
        /['"`](\/[A-Za-z0-9_\-\/\.]*srmapstudentcorner[A-Za-z0-9_\-\/\.]*|\/srmapstudentcorner\/[A-Za-z0-9_\-\/\.]+)['"`]/i
      ) ||
      onclickAttr.match(
        /['"`]([A-Za-z0-9_\-]+\.(?:aspx|jsp|php|do|action))['"`]/i
      );

    if (!pathMatch) continue;

    let href = pathMatch[1];

    if (!href.startsWith("http")) {
      href = href.startsWith("/")
        ? BASE + href
        : BASE + "/srmapstudentcorner/" + href;
    }

    if (seen.has(href)) continue;

    seen.add(href);

    links.push({
      label,
      url: href
    });
  }

  // Pass 3: quoted portal paths

  const rawPathRegex =
    /["'](\/srmapstudentcorner\/[A-Za-z0-9_\-\/\.]+)["']/gi;

  while ((m = rawPathRegex.exec(html))) {
    const href = BASE + m[1];

    if (seen.has(href)) continue;

    if (
      href.includes("captcha") ||
      href.includes("StudentLoginToPortal") ||
      href.includes(".css") ||
      href.includes(".js") ||
      href.includes(".png") ||
      href.includes(".jpg")
    ) {
      continue;
    }

    seen.add(href);

    const guessedLabel =
      m[1]
        .split("/")
        .filter(Boolean)
        .pop()
        .replace(/[-_]/g, " ");

    links.push({
      label: guessedLabel,
      url: href
    });
  }

  return links;
}

// ---------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------

module.exports = async function handler(req, res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    // =====================================================
    // DISCOVER
    // =====================================================

    if (
      req.method === "POST" &&
      req.body.step === "discover"
    ) {

      const {
        sessionCookie
      } = req.body;

      const pageRes = await fetch(
        LOGIN_PAGE_URL,
        {
          headers: {
            Cookie: sessionCookie || ""
          }
        }
      );

      const html = await pageRes.text();

      const links = discoverLinks(html);

      return res.status(200).json({
        links
      });
    }

    // =====================================================
    // FETCH PORTAL PAGE
    // =====================================================

    if (
      req.method === "POST" &&
      req.body.step === "fetchPage"
    ) {

      const {
        sessionCookie,
        path,
        postBody
      } = req.body;

      const url = path.startsWith("http")
        ? path
        : BASE + path;

      const fetchOpts = {
        headers: {
          Cookie: sessionCookie || ""
        }
      };

      if (postBody) {

        fetchOpts.method = "POST";

        fetchOpts.headers[
          "Content-Type"
        ] =
          "application/x-www-form-urlencoded";

        fetchOpts.headers[
          "X-Requested-With"
        ] = "XMLHttpRequest";

        fetchOpts.headers[
          "Referer"
        ] =
          BASE + "/srmapstudentcorner/HRDSystem";

        fetchOpts.body = postBody;
      }

      const pageRes =
        await fetch(url, fetchOpts);

      const html =
        await pageRes.text();

      const loggedOut =
        html
          .toLowerCase()
          .includes(
            "application number / register number"
          ) ||
        html
          .toLowerCase()
          .includes(
            'id="username"'
          );

      if (loggedOut) {

        return res.status(401).json({
          error:
            "Session expired -- please log in again."
        });
      }

      const tables =
        extractTables(html);

      const text =
        tables.length === 0
          ? extractBodyText(html)
          : "";

      return res.status(200).json({
        title: extractTitle(html),
        tables,
        text
      });
    }

    // =====================================================
    // START LOGIN / CAPTCHA
    // =====================================================

    if (
      req.method === "GET" &&
      req.query.step === "start"
    ) {

      // Load login page

      const pageRes =
        await fetch(
          LOGIN_PAGE_URL
        );

      let cookie =
        extractCookie(
          pageRes.headers.get("set-cookie"),
          ""
        );

      // Fetch CAPTCHA

      const captchaRes =
        await fetch(
          CAPTCHA_URL,
          {
            headers: {
              Cookie: cookie
            }
          }
        );

      cookie =
        extractCookie(
          captchaRes.headers.get("set-cookie"),
          cookie
        );

      const captchaBuffer =
        await captchaRes.arrayBuffer();

      const captchaBase64 =
        Buffer
          .from(captchaBuffer)
          .toString("base64");

      const contentType =
        captchaRes.headers.get(
          "content-type"
        ) ||
        "image/jpeg";

      // =================================================
      // OCR SPACE
      // =================================================

      let captchaText = "";

      try {

        const form =
          new URLSearchParams();

        form.append(
          "base64Image",
          `data:${contentType};base64,${captchaBase64}`
        );

        form.append(
          "language",
          "eng"
        );

        const ocrRes =
          await fetch(
            "https://api.ocr.space/parse/image",
            {
              method: "POST",

              headers: {
                apikey:
                  process.env
                    .OCR_SPACE_API_KEY,

                "Content-Type":
                  "application/x-www-form-urlencoded"
              },

              body:
                form.toString()
            }
          );

        const ocrData =
          await ocrRes.json();

        captchaText =
          ocrData
            ?.ParsedResults?.[0]
            ?.ParsedText
            ?.replace(
              /[^a-zA-Z0-9]/g,
              ""
            )
            ?.trim()
            ?.slice(0, 6) || "";

      } catch (e) {

        captchaText = "";
      }

      return res.status(200).json({

        sessionCookie:
          cookie,

        captchaImage:
          `data:${contentType};base64,${captchaBase64}`,

        captchaText
      });
    }

    // =====================================================
    // SRM LOGIN
    // =====================================================

    if (
      req.method === "POST" &&
      req.body.step === "login"
    ) {

      const {
        username,
        password,
        captcha,
        sessionCookie,

        // Optional information from frontend
        email,
        deviceId,
        deviceName,
        browser,
        operatingSystem,
        country,
        state,
        city
      } = req.body;

      // -----------------------------------------------
      // SRM LOGIN REQUEST
      // -----------------------------------------------

      const form =
        new URLSearchParams({
          txtUserName:
            username,

          txtAuthKey:
            password,

          ccode:
            captcha
        });

      const loginRes =
        await fetch(
          LOGIN_POST_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",

              Cookie:
                sessionCookie || ""
            },

            body:
              form.toString(),

            redirect:
              "manual"
          }
        );

      const newCookie =
        extractCookie(
          loginRes.headers.get("set-cookie"),
          sessionCookie
        );

      const redirectLocation =
        loginRes.headers.get(
          "location"
        );

      const html =
        await loginRes.text();

      // -----------------------------------------------
      // DETECT FAILURE
      // -----------------------------------------------

      const looksLikeFailure =
        html
          .toLowerCase()
          .includes("invalid") ||

        html
          .toLowerCase()
          .includes("incorrect") ||

        (
          loginRes.status >= 300 &&
          loginRes.status < 400 &&
          redirectLocation &&
          redirectLocation.includes(
            "StudentLoginToPortal"
          )
        );

      // -----------------------------------------------
      // FAILED LOGIN LOG
      // -----------------------------------------------

      if (looksLikeFailure) {

        await logLogin({

          registrationNo:
            username,

          email:
            email || null,

          status:
            "failed",

          req,

          deviceId:
            deviceId || null,

          deviceName:
            deviceName || null,

          browser:
            browser || null,

          operatingSystem:
            operatingSystem || null,

          country:
            country || null,

          state:
            state || null,

          city:
            city || null
        });

        return res.status(401).json({

          error:
            "Login didn't succeed -- wrong credentials/captcha, or the site's response format differs from what we expected.",

          debugStatus:
            loginRes.status,

          debugRedirect:
            redirectLocation || null
        });
      }

      // -----------------------------------------------
      // SUCCESSFUL LOGIN LOG
      // -----------------------------------------------

      await logLogin({

        registrationNo:
          username,

        email:
          email || null,

        status:
          "success",

        req,

        deviceId:
          deviceId || null,

        deviceName:
          deviceName || null,

        browser:
          browser || null,

        operatingSystem:
          operatingSystem || null,

        country:
          country || null,

        state:
          state || null,

        city:
          city || null
      });

      // -----------------------------------------------
      // RETURN SRM SESSION
      // -----------------------------------------------

      return res.status(200).json({

        sessionCookie:
          newCookie,

        redirectLocation:
          redirectLocation || null,

        message:
          "Login request completed. Next step: capture the URLs for your timetable/attendance/exam pages so we can fetch and parse them."
      });
    }

    // =====================================================
    // PROBE REPORTS
    // =====================================================

    if (
      req.method === "POST" &&
      req.body.step === "probeReports"
    ) {

      const {
        sessionCookie
      } = req.body;

      const REPORT_URL =
        BASE +
        "/srmapstudentcorner/students/report/studentreportresources.jsp";

      const candidates = [];

      for (
        let i = 1;
        i <= 25;
        i++
      ) {

        candidates.push(
          `ids=${i}`
        );
      }

      // Visit dashboard first

      try {

        await fetch(
          BASE +
            "/srmapstudentcorner/HRDSystem",
          {
            headers: {
              Cookie:
                sessionCookie || ""
            }
          }
        );

      } catch (e) {
        // Non-fatal
      }

      const results = [];

      for (
        const body of candidates
      ) {

        try {

          const r =
            await fetch(
              REPORT_URL,
              {
                method: "POST",

                headers: {

                  "Content-Type":
                    "application/x-www-form-urlencoded; charset=UTF-8",

                  "X-Requested-With":
                    "XMLHttpRequest",

                  "Referer":
                    BASE +
                    "/srmapstudentcorner/HRDSystem",

                  Cookie:
                    sessionCookie || ""
                },

                body
              }
            );

          const html =
            await r.text();

          const tables =
            extractTables(html);

          const text =
            tables.length === 0
              ? extractBodyText(html)
              : "";

          const snippet =
            (
              tables.length
                ? tables[0]
                    .slice(0, 2)
                    .map(row =>
                      row.join(" | ")
                    )
                    .join(" // ")
                : text
            ).slice(0, 160);

          const isGenericFallback =
            snippet
              .toLowerCase()
              .includes(
                "welcome to srm university"
              );

          if (
            snippet.trim() &&
            !isGenericFallback
          ) {

            results.push({
              body,
              snippet,
              hasTables:
                tables.length > 0
            });
          }

        } catch (e) {
          // Skip
        }
      }

      return res.status(200).json({
        results
      });
    }

    // =====================================================
    // PROBE JS ASSETS
    // =====================================================

    if (
      req.method === "GET" &&
      req.query.step === "probeAssets"
    ) {

      const candidateFiles = [

        "app.js",
        "main.js",
        "srmap.js",
        "srmapstudentcorner.js",
        "activity.js",
        "menu.js",
        "menus.js",
        "script.js",
        "scripts.js",
        "functions.js",
        "common.js",
        "portal.js",
        "student.js",
        "sidebar.js",
        "navigation.js",
        "custom1.js",
        "custom2.js",
        "site.js",
        "index.js",
        "global.js"

      ];

      const found = [];

      for (
        const file of candidateFiles
      ) {

        const url =
          BASE +
          "/srmapstudentcorner/resources/js/" +
          file;

        try {

          const r =
            await fetch(url);

          if (r.status !== 200) {
            continue;
          }

          const js =
            await r.text();

          if (js.length < 20) {
            continue;
          }

          const hasReport =
            /studentreportresources/i
              .test(js);

          const hasActivity =
            /clsactivity/i
              .test(js);

          if (
            hasReport ||
            hasActivity
          ) {

            const idx =
              js.search(
                /studentreportresources|clsactivity/i
              );

            const snippet =
              js.slice(
                Math.max(0, idx - 100),
                idx + 500
              );

            found.push({
              file,
              snippet
            });

          } else {

            found.push({
              file,
              snippet:
                "(file exists, " +
                js.length +
                " bytes, no relevant match)"
            });
          }

        } catch (e) {
          // Skip
        }
      }

      return res.status(200).json({
        found
      });
    }

    // =====================================================
    // SUBMIT ATTENDANCE CODE
    // =====================================================

    if (
      req.method === "POST" &&
      req.body.step ===
        "submitAttendanceCode"
    ) {

      const {
        sessionCookie,
        code
      } = req.body;

      if (!code) {

        return res.status(400).json({
          error:
            "Enter the attendance code first."
        });
      }

      const SUBMIT_URL =
        BASE +
        "/srmapstudentcorner/students/transaction/studentattendanceresources.jsp";

      const payload =
        new URLSearchParams({

          acode:
            code,

          dynamiclatdata:
            "0",

          dynamiclonxdata:
            "0",

          ids:
            "1"
        });

      const response =
        await fetch(
          SUBMIT_URL,
          {

            method:
              "POST",

            body:
              payload.toString(),

            headers: {

              "Content-Type":
                "application/x-www-form-urlencoded",

              "Cookie":
                sessionCookie || "",

              "Referer":
                BASE +
                "/srmapstudentcorner/HRDSystem"
            }
          }
        );

      const text =
        await response.text();

      let responseData;

      try {

        responseData =
          JSON.parse(
            text.trim()
          );

      } catch {

        try {

          responseData =
            JSON.parse(
              text
                .replace(
                  /<[^>]+>/g,
                  ""
                )
                .trim()
            );

        } catch {

          return res.status(200).json({

            success:
              false,

            message:
              "Couldn't read the portal's response -- try again."
          });
        }
      }

      if (
        responseData.resultstatus === "1"
      ) {

        return res.status(200).json({

          success:
            true,

          message:
            "Attendance captured successfully!"
        });

      } else if (
        typeof responseData.result ===
          "string" &&
        responseData.result.includes(
          "Your Attendance captured al"
        )
      ) {

        return res.status(200).json({

          success:
            true,

          message:
            "Attendance already captured for this class."
        });

      } else if (
        typeof responseData.result ===
          "string" &&
        responseData.result.includes(
          "You have entered the Wrong Attendance"
        )
      ) {

        return res.status(200).json({

          success:
            false,

          message:
            "Wrong attendance code -- double check and try again."
        });

      } else {

        return res.status(200).json({

          success:
            false,

          message:
            "Couldn't submit -- the code may be incorrect or expired."
        });
      }
    }

    // =====================================================
    // UNKNOWN REQUEST
    // =====================================================

    return res.status(400).json({
      error:
        "Unknown request."
    });

  } catch (e) {

    console.error(
      "SERVER ERROR:",
      e
    );

    return res.status(500).json({
      error:
        "Server error: " +
        e.message
    });
  }
};
