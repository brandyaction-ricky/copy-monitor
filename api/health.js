import { hasGateCredentials, json } from "../lib/gate.js";

export default function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
  return json(res, 200, {
    ok: true,
    service: "tooja",
    gateConfigured: hasGateCredentials(),
    accessProtected: Boolean(process.env.DASHBOARD_ACCESS_TOKEN),
    timestamp: new Date().toISOString(),
  });
}
