import crypto from "node:crypto";
import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v27.0";
const STATE_COOKIE = "instafetch_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();

app.disable("x-powered-by");

function htmlPage(title, message, status = 200) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | InstaFetch</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#f5f5f5;font:16px/1.6 Arial,sans-serif}
    main{width:min(520px,calc(100% - 40px));padding:32px;border:1px solid #333;border-radius:18px;background:#181818}
    h1{font-size:24px;margin:0 0 12px;color:#f97316}p{margin:0;color:#c9c9c9}
  </style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`;
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(item.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function clearStateCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=; Path=/auth/instagram; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

function pruneExpiredStates() {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(state);
  }
}

function getOAuthConfig() {
  const { META_APP_ID, META_APP_SECRET, META_CONFIG_ID, META_REDIRECT_URI } = process.env;
  if (!META_APP_ID || !META_APP_SECRET || !META_CONFIG_ID || !META_REDIRECT_URI) {
    return null;
  }

  let redirect;
  try {
    redirect = new URL(META_REDIRECT_URI);
  } catch {
    return null;
  }

  if (
    redirect.protocol !== "https:" ||
    redirect.pathname !== "/auth/instagram/callback" ||
    redirect.search ||
    redirect.hash
  ) {
    return null;
  }

  return { appId: META_APP_ID, appSecret: META_APP_SECRET, configId: META_CONFIG_ID, redirectUri: redirect.toString() };
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "InstaFetch API"
  });
});

// Starts Facebook Login for Business using the Meta configuration created for InstaFetch.
app.get("/auth/instagram", (req, res) => {
  const config = getOAuthConfig();
  if (!config) {
    return res.status(503).send(htmlPage(
      "Instagram login is not configured",
      "The server is missing valid Meta OAuth settings. Please complete the backend environment setup."
    ));
  }

  pruneExpiredStates();
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);

  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/auth/instagram; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  const authorizeUrl = new URL(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
  authorizeUrl.searchParams.set("client_id", config.appId);
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("config_id", config.configId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);

  return res.redirect(302, authorizeUrl.toString());
});

// Validates the one-time state and exchanges the authorization code server-side.
// The returned access token is deliberately not exposed or persisted until encrypted
// per-user token storage is configured.
app.get("/auth/instagram/callback", async (req, res) => {
  const config = getOAuthConfig();
  if (!config) {
    clearStateCookie(res);
    return res.status(503).send(htmlPage(
      "Instagram login is not configured",
      "The server is missing valid Meta OAuth settings."
    ));
  }

  const stateFromQuery = typeof req.query.state === "string" ? req.query.state : "";
  const stateFromCookie = getCookie(req, STATE_COOKIE);
  const stateExpiry = pendingStates.get(stateFromQuery);

  if (
    !stateFromQuery ||
    !stateFromCookie ||
    stateFromQuery.length !== stateFromCookie.length ||
    !crypto.timingSafeEqual(Buffer.from(stateFromQuery), Buffer.from(stateFromCookie)) ||
    !stateExpiry ||
    stateExpiry <= Date.now()
  ) {
    clearStateCookie(res);
    return res.status(400).send(htmlPage(
      "Login session expired",
      "The security check could not be completed. Please start Instagram login again."
    ));
  }

  pendingStates.delete(stateFromQuery);
  clearStateCookie(res);

  if (req.query.error) {
    return res.status(400).send(htmlPage(
      "Instagram authorization cancelled",
      "No account was connected. You can close this page."
    ));
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    return res.status(400).send(htmlPage(
      "Authorization code missing",
      "Meta did not return an authorization code. Please try connecting again."
    ));
  }

  try {
    const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", config.appId);
    tokenUrl.searchParams.set("client_secret", config.appSecret);
    tokenUrl.searchParams.set("redirect_uri", config.redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });

    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      return res.status(502).send(htmlPage(
        "Instagram authorization could not be verified",
        "Meta did not complete the server-side token exchange. Please check the Meta app configuration and try again."
      ));
    }

    // Do not log, return, or persist access tokens here. Encrypted per-user storage
    // must be added before this OAuth flow is treated as a saved account connection.
    return res.status(200).send(htmlPage(
      "Meta authorization verified",
      "The security check and server-side authorization-code exchange succeeded. Your Instagram account is not saved yet; secure encrypted token storage is the next required step."
    ));
  } catch {
    return res.status(502).send(htmlPage(
      "Meta connection unavailable",
      "The server could not complete the authorization exchange. Please try again later."
    ));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`InstaFetch API listening on port ${PORT}`);
});
