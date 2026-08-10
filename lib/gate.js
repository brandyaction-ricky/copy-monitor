import crypto from "node:crypto";

const HOST = "https://api.gateio.ws";
const PREFIX = "/api/v4";

const sha512 = (value = "") => crypto.createHash("sha512").update(value).digest("hex");

export function hasGateCredentials() {
  return Boolean(process.env.GATE_API_KEY && process.env.GATE_API_SECRET);
}

export async function gateGet(path, query = "") {
  if (!hasGateCredentials()) throw new Error("Gate.io read-only credentials are not configured");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = sha512("");
  const signText = ["GET", PREFIX + path, query, bodyHash, timestamp].join("\n");
  const sign = crypto
    .createHmac("sha512", process.env.GATE_API_SECRET)
    .update(signText)
    .digest("hex");

  const response = await fetch(`${HOST}${PREFIX}${path}${query ? `?${query}` : ""}`, {
    headers: {
      Accept: "application/json",
      KEY: process.env.GATE_API_KEY,
      Timestamp: timestamp,
      SIGN: sign,
    },
    cache: "no-store",
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.label || `Gate.io request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export function json(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.status(status).json(payload);
}
