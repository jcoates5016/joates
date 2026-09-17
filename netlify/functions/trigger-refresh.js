// The actual refresh pipeline runs in GitHub Actions now (see .github/workflows/refresh.yml and README) —
// Netlify Background Functions turned out to require a paid Pro plan, and this pipeline is too slow for a
// normal Netlify function's ~10-26s budget. So this function does the one thing a normal function budget can
// afford: fire a GitHub Actions "workflow_dispatch" via the GitHub API and return immediately. The frontend
// then polls /.netlify/functions/data the same way it always did, waiting for a new snapshot to show up.
export default async () => {
  const token = process.env.GH_PAT, owner = process.env.GH_OWNER, repo = process.env.GH_REPO;
  const workflowFile = process.env.GH_WORKFLOW_FILE || "refresh.yml";
  const branch = process.env.GH_BRANCH || "main";
  if (!token || !owner || !repo) {
    return new Response(JSON.stringify({ ok: false, error: "Missing GH_PAT / GH_OWNER / GH_REPO environment variables — see README." }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "content-type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ ref: branch })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return new Response(JSON.stringify({ ok: false, error: `GitHub API ${res.status}: ${body.slice(0, 300)}` }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }
  // GitHub's dispatch endpoint replies 204 with no body on success and gives no run ID back synchronously —
  // there's no faster way to hand the frontend anything more specific than "the workflow was told to start."
  return new Response(JSON.stringify({ ok: true, message: "GitHub Actions refresh triggered." }), {
    headers: { "content-type": "application/json" }
  });
};
