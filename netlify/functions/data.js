import { loadSnapshot } from "../../lib/store.js";

export default async () => {
  const snapshot = await loadSnapshot();
  if (!snapshot) {
    return new Response(JSON.stringify({ ok: false, error: "No snapshot yet — trigger a refresh first." }), {
      status: 404, headers: { "content-type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ ok: true, snapshot }), {
    headers: { "content-type": "application/json", "cache-control": "no-cache" }
  });
};
