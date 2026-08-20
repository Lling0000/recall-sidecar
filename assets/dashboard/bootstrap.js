"use strict";
const renderers = {
  reviews: renderReviews,
  memories: renderMemories,
  model: renderModel,
  health: renderHealth,
};
for (const node of document.querySelectorAll("nav button")) {
  node.addEventListener("click", () => renderers[node.dataset.page]().catch(showError));
}
async function start() {
  const token = window.location.hash.slice(1);
  if (token) {
    const response = await fetch("/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-local-bootstrap": "1" },
      body: JSON.stringify({ token }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "bootstrap_failed");
    state.csrf = body.csrf;
    history.replaceState(null, "", "/");
  } else {
    state.csrf = (await api("/api/session")).csrf;
  }
  await renderMemories();
}
start().catch(showError);
