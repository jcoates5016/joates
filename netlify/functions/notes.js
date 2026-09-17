import { loadNotes, saveNotes } from "../../lib/store.js";

export default async (req) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const notes = Array.isArray(body.notes) ? body.notes : [];
    await saveNotes(notes);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }
  const notes = await loadNotes();
  return new Response(JSON.stringify({ ok: true, notes }), { headers: { "content-type": "application/json" } });
};
