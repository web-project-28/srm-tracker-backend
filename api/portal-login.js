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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
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

    res.status(400).json({ error: "Unknown request." });
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
};
