import crypto from "node:crypto";
import express from "express";
import pg from "pg";

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 10000;
const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v27.0";
const STATE_COOKIE = "instafetch_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

app.disable("x-powered-by");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function htmlPage(title, message, status = 200) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)} | InstaFetch</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#f5f5f5;font:16px/1.6 Arial,sans-serif}
    main{width:min(520px,calc(100% - 40px));padding:32px;border:1px solid #333;border-radius:18px;background:#181818}
    h1{font-size:24px;margin:0 0 12px;color:#f97316}p{margin:0;color:#c9c9c9}
  </style>
</head>
<body><main><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p></main></body>
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

function setStateCookie(res, state) {
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/auth/instagram; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
}

function clearStateCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=; Path=/auth/instagram; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

function getOAuthConfig() {
  const { META_APP_ID, META_APP_SECRET, META_CONFIG_ID, META_REDIRECT_URI } = process.env;
  if (!META_APP_ID || !META_APP_SECRET || !META_CONFIG_ID || !META_REDIRECT_URI) return null;

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
  ) return null;

  return {
    appId: META_APP_ID,
    appSecret: META_APP_SECRET,
    configId: META_CONFIG_ID,
    redirectUri: redirect.toString()
  };
}

function getEncryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 32-byte hexadecimal value.");
  }
  return Buffer.from(value, "hex");
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    encryptedToken: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

async function initializeDatabase() {
  if (!pool) throw new Error("DATABASE_URL is not configured.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash CHAR(64) PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS instagram_connections (
      instagram_user_id TEXT PRIMARY KEY,
      username TEXT,
      encrypted_access_token TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      token_auth_tag TEXT NOT NULL,
      token_type TEXT,
      token_expires_at TIMESTAMPTZ,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("DELETE FROM oauth_states WHERE expires_at <= NOW()");
}

const databaseReady = initializeDatabase().then(
  () => true,
  error => {
    console.error("Database initialization failed:", error.message);
    return false;
  }
);

async function graphGet(path, accessToken) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error("Meta Graph API request failed.");
  }
  return data;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "InstaFetch API" });
});

app.get("/ready", async (_req, res) => {
  const ready = await databaseReady;
  if (!ready) {
    return res.status(503).json({ status: "not_ready", database: "unavailable" });
  }
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ status: "ready", database: "connected" });
  } catch {
    return res.status(503).json({ status: "not_ready", database: "unavailable" });
  }
});

// Starts the Facebook Login for Business flow for the saved Unified Login configuration.
app.get("/auth/instagram", async (_req, res) => {
  const config = getOAuthConfig();
  if (!config) {
    return res.status(503).send(htmlPage(
      "Instagram login is not configured",
      "The server is missing valid Meta OAuth settings."
    ));
  }

  if (!(await databaseReady)) {
    return res.status(503).send(htmlPage(
      "Database unavailable",
      "The account connection service is temporarily unavailable. Please try again later."
    ));
  }

  try {
    const state = crypto.randomBytes(32).toString("hex");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    await pool.query(
      "INSERT INTO oauth_states (state_hash, expires_at) VALUES ($1, NOW() + INTERVAL '10 minutes')",
      [stateHash]
    );

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
  } catch {
    return res.status(503).send(htmlPage(
      "Instagram login unavailable",
      "The server could not start a secure login session. Please try again later."
    ));
  }
});

app.get("/auth/instagram/callback", async (req, res) => {
  clearStateCookie(res);
  const config = getOAuthConfig();
  if (!config) {
    return res.status(503).send(htmlPage(
      "Instagram login is not configured",
      "The server is missing valid Meta OAuth settings."
    ));
  }

  if (!(await databaseReady)) {
    return res.status(503).send(htmlPage(
      "Database unavailable",
      "The account connection service is temporarily unavailable."
    ));
  }

  const stateFromQuery = typeof req.query.state === "string" ? req.query.state : "";
  const stateFromCookie = getCookie(req, STATE_COOKIE);
  if (
    !stateFromQuery ||
    !stateFromCookie ||
    stateFromQuery.length !== stateFromCookie.length ||
    !crypto.timingSafeEqual(Buffer.from(stateFromQuery), Buffer.from(stateFromCookie))
  ) {
    return res.status(400).send(htmlPage(
      "Login session expired",
      "The security check could not be completed. Please start Instagram login again."
    ));
  }

  const stateHash = crypto.createHash("sha256").update(stateFromQuery).digest("hex");
  const consumedState = await pool.query(
    "DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > NOW() RETURNING state_hash",
    [stateHash]
  );
  if (consumedState.rowCount !== 1) {
    return res.status(400).send(htmlPage(
      "Login session expired",
      "This login session has expired or has already been used. Please start again."
    ));
  }

  if (req.query.error) {
    return res.status(400).send(htmlPage(
      "Instagram authorization cancelled",
      "No Instagram account was connected."
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
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      return res.status(502).send(htmlPage(
        "Instagram authorization could not be verified",
        "Meta did not complete the server-side token exchange. Check the app configuration and try again."
      ));
    }

    // Resolve the Instagram assets explicitly granted to this Unified Login identity.
    const metaUser = await graphGet("me?fields=id", tokenData.access_token);
    if (!metaUser.id) throw new Error("Meta user ID was not returned.");

    const assigned = await graphGet(
      `${encodeURIComponent(metaUser.id)}/assigned_instagram_accounts?fields=id,username`,
      tokenData.access_token
    );
    const accounts = Array.isArray(assigned.data) ? assigned.data : [];
    if (accounts.length === 0) {
      return res.status(200).send(htmlPage(
        "Meta login verified",
        "Login succeeded, but Meta did not return an Instagram account assigned to this configuration. No token was saved."
      ));
    }

    const encrypted = encryptToken(tokenData.access_token);
    const expiresAt = Number.isFinite(Number(tokenData.expires_in))
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
      : null;

    for (const account of accounts) {
      if (!account.id) continue;
      await pool.query(
        `INSERT INTO instagram_connections
          (instagram_user_id, username, encrypted_access_token, token_iv, token_auth_tag, token_type, token_expires_at, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (instagram_user_id) DO UPDATE SET
          username = EXCLUDED.username,
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          token_iv = EXCLUDED.token_iv,
          token_auth_tag = EXCLUDED.token_auth_tag,
          token_type = EXCLUDED.token_type,
          token_expires_at = EXCLUDED.token_expires_at,
          updated_at = NOW()`,
        [
          String(account.id),
          typeof account.username === "string" ? account.username : null,
          encrypted.encryptedToken,
          encrypted.iv,
          encrypted.authTag,
          typeof tokenData.token_type === "string" ? tokenData.token_type : null,
          expiresAt
        ]
      );
    }

    const savedAccounts = accounts.filter(account => account.id);
    const names = savedAccounts
      .map(account => account.username ? `@${account.username}` : "Instagram account")
      .join(", ");

    return res.status(200).send(htmlPage(
      "Instagram account connected",
      `Meta authorization succeeded and ${savedAccounts.length} account(s) were saved with encrypted token storage: ${names}. The token is never sent to the browser.`
    ));
  } catch {
    return res.status(502).send(htmlPage(
      "Instagram connection could not be saved",
      "Meta authorization or account lookup did not complete. No success is being reported; please check the Meta configuration and try again."
    ));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`InstaFetch API listening on port ${PORT}`);
});
