import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 10000;

app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "InstaFetch API"
  });
});

// Meta redirects users here after the Instagram authorization step.
// This endpoint intentionally does not expose or log authorization codes.
app.get("/auth/instagram/callback", (req, res) => {
  if (req.query.error) {
    return res.status(400).send(
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>InstaFetch</title></head><body><h1>Instagram authorization was not completed</h1><p>You can close this page and try again.</p></body></html>"
    );
  }

  if (typeof req.query.code !== "string" || !req.query.code) {
    return res.status(400).send(
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>InstaFetch</title></head><body><h1>Callback endpoint is working</h1><p>No authorization code was received. Do not use this as a completed login.</p></body></html>"
    );
  }

  return res.status(200).send(
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>InstaFetch</title></head><body><h1>Instagram callback reached</h1><p>The redirect endpoint is working. Secure authorization-code validation and token exchange are the next setup step. You are not signed in yet.</p></body></html>"
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`InstaFetch API listening on port ${PORT}`);
});
