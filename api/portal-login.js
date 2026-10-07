// api/portal-login.js
// SRM Portal Backend for Vercel
//
// GET  ?step=start
//      Starts an SRM login session and gets captcha.
//
// POST step=login
//      Logs into SRM using the same session/captcha.
//
// POST step=discover
// POST step=fetchPage
// POST step=probeReports
// GET  ?step=probeAssets
// POST step=submitAttendanceCode

const BASE = "https://student.srmap.edu.in";

const LOGIN_PAGE_URL =
  BASE + "/srmapstudentcorner/";

const CAPTCHA_URL =
  BASE + "/srmapstudentcorner/captchas";

const LOGIN_POST_URL =
  BASE + "/srmapstudentcorner/StudentLoginToPortal";

const PORTAL_HOME_URL =
  BASE + "/srmapstudentcorner/HRDSystem";


/* =========================================================
   COOKIE HANDLING
   ========================================================= */

/*
 * Node/Vercel fetch can expose multiple Set-Cookie headers.
 * We preserve every cookie instead of using a simple
 * split(",") which can break cookies containing Expires.
 */
function getSetCookieValues(headers) {
  try {
    if (
      typeof headers.getSetCookie === "function"
    ) {
      const values = headers.getSetCookie();

      if (
        Array.isArray(values) &&
        values.length
      ) {
        return values;
      }
    }
  } catch (e) {
    // Continue to fallback.
  }

  const combined =
    headers.get("set-cookie");

  if (!combined) {
    return [];
  }

  /*
   * Fallback parser.
   *
   * Split only when the comma appears to start
   * another cookie rather than being inside Expires.
   */
  const result = [];
  let current = "";
  let expires = false;

  for (let i = 0; i < combined.length; i++) {
    const ch = combined[i];

    if (ch === ",") {
      if (!expires) {
        if (current.trim()) {
          result.push(current.trim());
        }

        current = "";
        continue;
      }
    }

    current += ch;

    if (
      current
        .toLowerCase()
        .endsWith("expires=")
    ) {
      expires = true;
    }

    if (
      expires &&
      ch === ";"
    ) {
      expires = false;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}


function mergeCookies(
  existingCookie,
  headers
) {
  const cookies = {};

  /*
   * Existing Cookie header.
   */
  String(existingCookie || "")
    .split(";")
    .forEach(part => {
      const item = part.trim();

      if (!item) return;

      const index =
        item.indexOf("=");

      if (index === -1) return;

      const name =
        item
          .slice(0, index)
          .trim();

      const value =
        item
          .slice(index + 1)
          .trim();

      if (name) {
        cookies[name] = value;
      }
    });


  /*
   * New Set-Cookie headers.
   */
  const setCookies =
    getSetCookieValues(headers);

  for (
    const cookie of setCookies
  ) {
    const firstPart =
      String(cookie)
        .split(";")[0]
        .trim();

    const index =
      firstPart.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name =
      firstPart
        .slice(0, index)
        .trim();

    const value =
      firstPart
        .slice(index + 1)
        .trim();

    if (name) {
      cookies[name] = value;
    }
  }

  return Object.entries(cookies)
    .map(
      ([name, value]) =>
        `${name}=${value}`
    )
    .join("; ");
}


/* =========================================================
   HTML HELPERS
   ========================================================= */

function extractTables(html) {
  const stripTags = s =>
    s
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /&nbsp;/gi,
        " "
      )
      .replace(
        /&amp;/gi,
        "&"
      )
      .replace(
        /&quot;/gi,
        '"'
      )
      .replace(
        /&#39;/gi,
        "'"
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const tables = [];

  const tableRegex =
    /<table[\s\S]*?<\/table>/gi;

  let tm;

  while (
    (tm = tableRegex.exec(html))
  ) {
    const tableHtml =
      tm[0];

    const rows = [];

    const rowRegex =
      /<tr[\s\S]*?<\/tr>/gi;

    let rm;

    while (
      (rm =
        rowRegex.exec(tableHtml))
    ) {
      const rowHtml =
        rm[0];

      const cells = [];

      const cellRegex =
        /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

      let cm;

      while (
        (cm =
          cellRegex.exec(
            rowHtml
          ))
      ) {
        cells.push(
          stripTags(cm[1])
        );
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


function extractTitle(html) {
  const match =
    html.match(
      /<title>([\s\S]*?)<\/title>/i
    );

  return match
    ? match[1].trim()
    : "";
}


function extractBodyText(html) {
  let cleaned =
    html
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<nav[\s\S]*?<\/nav>/gi,
        " "
      )
      .replace(
        /<header[\s\S]*?<\/header>/gi,
        " "
      )
      .replace(
        /<footer[\s\S]*?<\/footer>/gi,
        " "
      );

  const bodyMatch =
    cleaned.match(
      /<body[\s\S]*?>([\s\S]*?)<\/body>/i
    );

  const scope =
    bodyMatch
      ? bodyMatch[1]
      : cleaned;

  return scope
    .replace(
      /<[^>]+>/g,
      "\n"
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .split("\n")
    .map(
      line => line.trim()
    )
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}


/* =========================================================
   LINK DISCOVERY
   ========================================================= */

function discoverLinks(html) {
  const stripTags = s =>
    s
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /&nbsp;/gi,
        " "
      )
      .replace(
        /&amp;/gi,
        "&"
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const seen =
    new Set();

  const links = [];

  /*
   * Normal href links.
   */
  const linkRegex =
    /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;

  while (
    (m =
      linkRegex.exec(html))
  ) {
    let href =
      m[1].trim();

    const label =
      stripTags(m[2]);

    if (!label) {
      continue;
    }

    if (
      href.startsWith(
        "javascript:"
      ) ||
      href.startsWith(
        "mailto:"
      ) ||
      (
        href.startsWith("http") &&
        !href.includes(
          "student.srmap.edu.in"
        )
      )
    ) {
      continue;
    }

    if (
      !href.startsWith("http")
    ) {
      href =
        href.startsWith("/")
          ? BASE + href
          : BASE +
            "/srmapstudentcorner/" +
            href;
    }

    if (seen.has(href)) {
      continue;
    }

    seen.add(href);

    links.push({
      label,
      url: href
    });
  }


  /*
   * onclick navigation.
   */
  const clickableRegex =
    /<a\s+[^>]*onclick\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  while (
    (m =
      clickableRegex.exec(
        html
      ))
  ) {
    const onclick =
      m[1];

    const label =
      stripTags(m[2]);

    if (!label) {
      continue;
    }

    const pathMatch =
      onclick.match(
        /['"`](\/[A-Za-z0-9_\-\/\.]*srmapstudentcorner[A-Za-z0-9_\-\/\.]*|\/srmapstudentcorner\/[A-Za-z0-9_\-\/\.]+)['"`]/i
      ) ||
      onclick.match(
        /['"`]([A-Za-z0-9_\-]+\.(?:aspx|jsp|php|do|action))['"`]/i
      );

    if (!pathMatch) {
      continue;
    }

    let href =
      pathMatch[1];

    if (
      !href.startsWith("http")
    ) {
      href =
        href.startsWith("/")
          ? BASE + href
          : BASE +
            "/srmapstudentcorner/" +
            href;
    }

    if (seen.has(href)) {
      continue;
    }

    seen.add(href);

    links.push({
      label,
      url: href
    });
  }


  /*
   * Raw portal paths inside JavaScript.
   */
  const rawPathRegex =
    /["'](\/srmapstudentcorner\/[A-Za-z0-9_\-\/\.]+)["']/gi;

  while (
    (m =
      rawPathRegex.exec(html))
  ) {
    const href =
      BASE + m[1];

    if (seen.has(href)) {
      continue;
    }

    if (
      href.includes(
        "captcha"
      ) ||
      href.includes(
        "StudentLoginToPortal"
      ) ||
      href.includes(
        ".css"
      ) ||
      href.includes(
        ".js"
      ) ||
      href.includes(
        ".png"
      ) ||
      href.includes(
        ".jpg"
      )
    ) {
      continue;
    }

    seen.add(href);

    const guessedLabel =
      m[1]
        .split("/")
        .filter(Boolean)
        .pop()
        .replace(
          /[-_]/g,
          " "
        );

    links.push({
      label:
        guessedLabel,
      url: href
    });
  }

  return links;
}


/* =========================================================
   LOGIN RESPONSE DETECTION
   ========================================================= */

function isLoginPage(html) {
  const lower =
    String(html || "")
      .toLowerCase();

  return (
    lower.includes(
      "application number / register number"
    ) ||
    lower.includes(
      "txtusername"
    ) ||
    lower.includes(
      "txtauthkey"
    ) ||
    lower.includes(
      "studentlogintoportal"
    ) ||
    lower.includes(
      'id="username"'
    )
  );
}


function hasExplicitLoginFailure(html) {
  const lower =
    String(html || "")
      .toLowerCase();

  const failureMessages = [
    "invalid username",
    "invalid password",
    "invalid credentials",
    "invalid captcha",
    "incorrect captcha",
    "wrong captcha",
    "captcha is incorrect",
    "captcha incorrect",
    "login failed",
    "authentication failed",
    "invalid user",
    "invalid login",
    "incorrect username",
    "incorrect password"
  ];

  return failureMessages.some(
    message =>
      lower.includes(message)
  );
}


function looksLoggedIn(html) {
  const lower =
    String(html || "")
      .toLowerCase();

  const signals = [
    "attendance",
    "timetable",
    "student dashboard",
    "student profile",
    "academic",
    "examination",
    "fee",
    "hrdsystem"
  ];

  let count = 0;

  for (
    const signal of signals
  ) {
    if (
      lower.includes(signal)
    ) {
      count++;
    }
  }

  return (
    count >= 2 &&
    !isLoginPage(html)
  );
}


/* =========================================================
   MAIN VERCEL HANDLER
   ========================================================= */

module.exports =
  async function handler(
    req,
    res
  ) {
    /*
     * CORS
     */
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

    if (
      req.method ===
      "OPTIONS"
    ) {
      return res
        .status(200)
        .end();
    }


    try {

      /* ===================================================
         DISCOVER
         =================================================== */

      if (
        req.method === "POST" &&
        req.body?.step ===
          "discover"
      ) {
        const {
          sessionCookie
        } = req.body;

        const pageRes =
          await fetch(
            LOGIN_PAGE_URL,
            {
              headers: {
                Cookie:
                  sessionCookie || "",
                Accept:
                  "text/html,application/xhtml+xml",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
              }
            }
          );

        const html =
          await pageRes.text();

        return res
          .status(200)
          .json({
            links:
              discoverLinks(
                html
              )
          });
      }


      /* ===================================================
         FETCH PAGE
         =================================================== */

      if (
        req.method === "POST" &&
        req.body?.step ===
          "fetchPage"
      ) {
        const {
          sessionCookie,
          path,
          postBody
        } = req.body;

        if (!path) {
          return res
            .status(400)
            .json({
              error:
                "Missing page path."
            });
        }

        const url =
          path.startsWith("http")
            ? path
            : BASE + path;

        const headers = {
          Cookie:
            sessionCookie || "",
          Accept:
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
        };

        const options = {
          headers
        };

        if (postBody) {
          options.method =
            "POST";

          headers[
            "Content-Type"
          ] =
            "application/x-www-form-urlencoded";

          headers[
            "X-Requested-With"
          ] =
            "XMLHttpRequest";

          headers.Referer =
            PORTAL_HOME_URL;

          options.body =
            postBody;
        }

        const pageRes =
          await fetch(
            url,
            options
          );

        const html =
          await pageRes.text();

        if (
          isLoginPage(html)
        ) {
          return res
            .status(401)
            .json({
              error:
                "Session expired -- please log in again."
            });
        }

        const tables =
          extractTables(
            html
          );

        const text =
          tables.length === 0
            ? extractBodyText(
                html
              )
            : "";

        return res
          .status(200)
          .json({
            title:
              extractTitle(
                html
              ),
            tables,
            text
          });
      }


      /* ===================================================
         START LOGIN
         =================================================== */

      if (
        req.method === "GET" &&
        req.query?.step ===
          "start"
      ) {

        /*
         * STEP 1:
         * Establish SRM session.
         */

        const pageRes =
          await fetch(
            LOGIN_PAGE_URL,
            {
              method:
                "GET",

              redirect:
                "follow",

              headers: {
                Accept:
                  "text/html,application/xhtml+xml",
                "Accept-Language":
                  "en-US,en;q=0.9",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
              }
            }
          );

        let sessionCookie =
          mergeCookies(
            "",
            pageRes.headers
          );


        /*
         * STEP 2:
         * Get captcha using EXACT same session.
         */

        const captchaRes =
          await fetch(
            CAPTCHA_URL,
            {
              method:
                "GET",

              headers: {
                Cookie:
                  sessionCookie,

                Referer:
                  LOGIN_PAGE_URL,

                Accept:
                  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",

                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
              }
            }
          );

        sessionCookie =
          mergeCookies(
            sessionCookie,
            captchaRes.headers
          );

        if (
          !captchaRes.ok
        ) {
          return res
            .status(502)
            .json({
              error:
                "SRM captcha could not be loaded.",
              debugStatus:
                captchaRes.status
            });
        }

        const captchaBuffer =
          await captchaRes.arrayBuffer();

        const captchaBase64 =
          Buffer.from(
            captchaBuffer
          ).toString(
            "base64"
          );

        const contentType =
          captchaRes.headers.get(
            "content-type"
          ) ||
          "image/jpeg";


        /*
         * STEP 3:
         * OCR captcha.
         */

        let captchaText =
          "";

        try {
          if (
            process.env
              .OCR_SPACE_API_KEY
          ) {
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
                  method:
                    "POST",

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

            if (
              ocrRes.ok
            ) {
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
                  ?.slice(
                    0,
                    6
                  ) ||
                "";
            }
          }
        } catch (e) {
          captchaText =
            "";
        }


        return res
          .status(200)
          .json({
            sessionCookie,
            captchaImage:
              `data:${contentType};base64,${captchaBase64}`,
            captchaText
          });
      }


      /* ===================================================
         LOGIN
         =================================================== */

      if (
        req.method === "POST" &&
        req.body?.step ===
          "login"
      ) {
        const {
          username,
          password,
          captcha,
          sessionCookie
        } = req.body;


        /*
         * Validate input.
         */

        if (!username) {
          return res
            .status(400)
            .json({
              error:
                "Registration number is required."
            });
        }

        if (!password) {
          return res
            .status(400)
            .json({
              error:
                "Portal password is required."
            });
        }

        if (!captcha) {
          return res
            .status(400)
            .json({
              error:
                "Captcha is required."
            });
        }

        if (!sessionCookie) {
          return res
            .status(400)
            .json({
              error:
                "SRM session is missing. Please refresh the captcha and try again."
            });
        }


        /*
         * Build exact login form.
         */

        const form =
          new URLSearchParams();
form.set(
          "txtUserName",
          String(
            username
          ).trim()
        );

        form.set(
          "txtAuthKey",
          String(
            password
          )
        );

        form.set(
          "ccode",
          String(
            captcha
          ).trim()
        );


        /*
         * Submit login.
         */

        const loginRes =
          await fetch(
            LOGIN_POST_URL,
            {
              method:
                "POST",

              redirect:
                "manual",

              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded",

                Cookie:
                  sessionCookie,

                Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

                "Accept-Language":
                  "en-US,en;q=0.9",

                Referer:
                  LOGIN_PAGE_URL,

                Origin:
                  BASE,

                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

                "Cache-Control":
                  "no-cache",

                Pragma:
                  "no-cache"
              },

              body:
                form.toString()
            }
          );


        /*
         * VERY IMPORTANT:
         *
         * Keep cookies returned by the login request.
         */

        const newCookie =
          mergeCookies(
            sessionCookie,
            loginRes.headers
          );

        const redirectLocation =
          loginRes.headers.get(
            "location"
          );

        const html =
          await loginRes.text();


        /*
         * SRM explicitly rejected request.
         */

        if (
          loginRes.status ===
            401 ||
          loginRes.status ===
            403
        ) {
          return res
            .status(401)
            .json({
              error:
                "SRM rejected the login request. Please check your registration number, password, and captcha.",
              debugStatus:
                loginRes.status,
              debugRedirect:
                redirectLocation ||
                null
            });
        }


        /*
         * Explicit failure message.
         */

        if (
          hasExplicitLoginFailure(
            html
          )
        ) {
          return res
            .status(401)
            .json({
              error:
                "SRM rejected the registration number, password, or captcha.",
              debugStatus:
                loginRes.status
            });
        }


        /*
         * Redirect handling.
         */

        if (
          loginRes.status >=
            300 &&
          loginRes.status <
            400
        ) {

          if (
            !redirectLocation
          ) {
            return res
              .status(401)
              .json({
                error:
                  "SRM returned a redirect without a destination.",
                debugStatus:
                  loginRes.status
              });
          }

          const absoluteRedirect =
            redirectLocation.startsWith(
              "http"
            )
              ? redirectLocation
              : new URL(
                  redirectLocation,
                  BASE
                ).href;

          const redirectLower =
            absoluteRedirect
              .toLowerCase();

          /*
           * Redirecting back to the login endpoint
           * means SRM rejected the login.
           */

          const redirectedBackToLogin =
            redirectLower.includes(
              "studentlogintoportal"
            ) ||
            redirectLower ===
              LOGIN_PAGE_URL.toLowerCase();

          if (
            redirectedBackToLogin
          ) {
            return res
              .status(401)
              .json({
                error:
                  "SRM redirected back to the login page. The registration number, password, or captcha was rejected.",
                debugStatus:
                  loginRes.status,
                debugRedirect:
                  absoluteRedirect
              });
          }


          /*
           * Any other SRM redirect is a strong
           * indication that login succeeded.
           */

          return res
            .status(200)
            .json({
              sessionCookie:
                newCookie,

              redirectLocation:
                absoluteRedirect,

              loginSuccess:
                true,

              message:
                "SRM login successful."
            });
        }


        /*
         * If the response itself looks like
         * a logged-in portal page.
         */

        if (
          looksLoggedIn(
            html
          )
        ) {
          return res
            .status(200)
            .json({
              sessionCookie:
                newCookie,

              redirectLocation:
                redirectLocation ||
                null,

              loginSuccess:
                true,

              message:
                "SRM login successful."
            });
        }


        /*
         * Verify the session directly against
         * the SRM dashboard.
         */

        try {
          const verifyRes =
            await fetch(
              PORTAL_HOME_URL,
              {
                method:
                  "GET",

                redirect:
                  "follow",

                headers: {
                  Cookie:
                    newCookie,

                  Referer:
                    LOGIN_POST_URL,

                  Accept:
                    "text/html,application/xhtml+xml,application/xhtml+xml;q=0.9,*/*;q=0.8",

                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                }
              }
            );

          const verifyHtml =
            await verifyRes.text();


          /*
           * If dashboard does NOT look like login page,
           * consider session valid.
           */

          if (
            verifyRes.ok &&
            !isLoginPage(
              verifyHtml
            )
          ) {
            return res
              .status(200)
              .json({
                sessionCookie:
                  newCookie,

                redirectLocation:
                  redirectLocation ||
                  null,

                loginSuccess:
                  true,

                message:
                  "SRM login successful."
              });
          }


          /*
           * SRM sent us back to login.
           */

          if (
            isLoginPage(
              verifyHtml
            )
          ) {
            return res
              .status(401)
              .json({
                error:
                  "SRM did not create a logged-in session. Please refresh the captcha and try again.",
                debugStatus:
                  loginRes.status
              });
          }

        } catch (verifyError) {
          /*
           * Verification itself failed.
           * Don't expose internal details.
           */
        }


        /*
         * Unknown SRM response.
         */

        return res
          .status(401)
          .json({
            error:
              "SRM returned an unexpected login response. Please refresh the captcha and try again.",
            debugStatus:
              loginRes.status,
            debugRedirect:
              redirectLocation ||
              null
          });
      }


      /* ===================================================
         PROBE REPORTS
         =================================================== */

      if (
        req.method === "POST" &&
        req.body?.step ===
          "probeReports"
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


        /*
         * Visit dashboard first.
         */

        try {
          await fetch(
            PORTAL_HOME_URL,
            {
              headers: {
                Cookie:
                  sessionCookie || "",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
              }
            }
          );
        } catch (e) {
          // Continue.
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
                  method:
                    "POST",

                  headers: {
                    "Content-Type":
                      "application/x-www-form-urlencoded; charset=UTF-8",

                    "X-Requested-With":
                      "XMLHttpRequest",

                    Referer:
                      PORTAL_HOME_URL,

                    Cookie:
                      sessionCookie || "",

                    "User-Agent":
                      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
                  },

                  body
                }
              );

            const html =
              await r.text();

            const tables =
              extractTables(
                html
              );

            const text =
              tables.length === 0
                ? extractBodyText(
                    html
                  )
                : "";

            const snippet =
              (
                tables.length
                  ? tables[0]
                      .slice(
                        0,
                        2
                      )
                      .map(
                        row =>
                          row.join(
                            " | "
                          )
                      )
                      .join(
                        " // "
                      )
                  : text
              ).slice(
                0,
                160
              );

            const generic =
              snippet
                .toLowerCase()
                .includes(
                  "welcome to srm university"
                );

            if (
              snippet.trim() &&
              !generic
            ) {
              results.push({
                body,
                snippet,
                hasTables:
                  tables.length >
                  0
              });
            }

          } catch (e) {
            // Ignore individual failures.
          }
        }

        return res
          .status(200)
          .json({
            results
          });
      }


      /* ===================================================
         PROBE ASSETS
         =================================================== */

      if (
        req.method === "GET" &&
        req.query?.step ===
          "probeAssets"
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

            if (
              r.status !==
              200
            ) {
              continue;
            }

            const js =
              await r.text();

            if (
              js.length < 20
            ) {
              continue;
            }

            const hasReport =
              /studentreportresources/i.test(
                js
              );

            const hasActivity =
              /clsactivity/i.test(
                js
              );

            if (
              hasReport ||
              hasActivity
            ) {
              const idx =
                js.search(
                  /studentreportresources|clsactivity/i
                );

              found.push({
                file,
                snippet:
                  js.slice(
                    Math.max(
                      0,
                      idx - 100
                    ),
                    idx + 500
                  )
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
            // Ignore unavailable files.
          }
        }

        return res
          .status(200)
          .json({
            found
          });
      }


      /* ===================================================
         ATTENDANCE CODE
         =================================================== */

      if (
        req.method === "POST" &&
        req.body?.step ===
          "submitAttendanceCode"
      ) {
        const {
          sessionCookie,
          code
        } = req.body;

        if (!code) {
          return res
            .status(400)
            .json({
              error:
                "Enter the attendance code first."
            });
        }

        const SUBMIT_URL =
          BASE +
          "/srmapstudentcorner/students/transaction/studentattendanceresources.jsp";

        const payload =
          new URLSearchParams({
            acode: code,
            dynamiclatdata:
              "0",
            dynamiclonxdata:
              "0",
            ids: "1"
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

                Cookie:
                  sessionCookie || "",

                Referer:
                  PORTAL_HOME_URL,

                "X-Requested-With":
                  "XMLHttpRequest",

                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
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
            return res
              .status(200)
              .json({
                success: false,
                message:
                  "Couldn't read the portal's response -- try again."
              });
          }
        }

        if (
          responseData.resultstatus ===
          "1"
        ) {
          return res
            .status(200)
            .json({
              success: true,
              message:
                "Attendance captured successfully!"
            });
        }

        if (
          typeof responseData.result ===
            "string" &&
          responseData.result.includes(
            "Your Attendance captured al"
          )
        ) {
          return res
            .status(200)
            .json({
              success: true,
              message:
                "Attendance already captured for this class."
            });
        }

        if (
          typeof responseData.result ===
            "string" &&
          responseData.result.includes(
            "You have entered the Wrong Attendance"
          )
        ) {
          return res
            .status(200)
            .json({
              success: false,
              message:
                "Wrong attendance code -- double check and try again."
            });
        }

        return res
          .status(200)
          .json({
            success: false,
            message:
              "Couldn't submit -- the code may be incorrect or expired."
          });
      }


      /* ===================================================
         UNKNOWN REQUEST
         =================================================== */

      return res
        .status(400)
        .json({
          error:
            "Unknown request."
        });

    } catch (e) {

      console.error(
        "portal-login error:",
        e
      );

      return res
        .status(500)
        .json({
          error:
            "Server error: " +
            (
              e?.message ||
              "Unknown error"
            )
        });
    }
  };
     
