"use strict";
async function renderReviews() {
  setPage("reviews", "待核对", "检查点知识已生效；每日整合建议只有确认后才会改变知识库。");
  const { reviews, consolidations } = await api("/api/reviews");
  if (!reviews.length && !consolidations.length) {
    return content.append(emptyState("没有需要核对的内容", "check-circle"));
  }
  const list = element("div", undefined, "review-list");
  for (const review of reviews) list.append(extractionReview(review));
  for (const suggestion of consolidations) list.append(consolidationReview(suggestion));
  content.append(list);
}

function extractionReview(review) {
  const panel = element("article", undefined, "review-panel");
  const heading = element("div", undefined, "review-heading");
  heading.append(
    element("h2", review.newCard.title),
    element(
      "span",
      review.action === "create"
        ? `新建 · v${review.newVersion}`
        : `v${review.oldVersion} → v${review.newVersion}`,
      "muted",
    ),
  );
  const compare = element("div", undefined, "compare");
  const newSide = knowledgeCard(
    review.action === "create" ? "新知识" : "新版本",
    review.newCard,
  );
  if (review.action === "create") {
    compare.classList.add("create");
    compare.append(newSide);
  } else {
    compare.append(knowledgeCard("旧版本", review.oldCard), newSide);
  }
  const actions = element("div", undefined, "actions");
  if (review.action === "create") {
    actions.append(
      actionButton("删除这条记忆", "danger-button", async () => {
        if (!window.confirm("永久删除这条新记忆和全部版本？")) return;
        await api(`/api/memories/${encodeURIComponent(review.memoryId)}`, {
          method: "DELETE",
          body: JSON.stringify({ confirm_memory_id: review.memoryId }),
        });
        await renderReviews();
      }),
    );
  } else {
    actions.append(
      actionButton(
        "恢复旧版",
        "secondary",
        async () => {
          await api(`/api/memories/${encodeURIComponent(review.memoryId)}/rollback`, {
            method: "POST",
            body: JSON.stringify({ version_id: review.oldVersionId }),
          });
          await renderReviews();
        },
        "arrow-clockwise",
      ),
    );
  }
  actions.append(
    actionButton(
      review.action === "create" ? "确认保留" : "确认没问题",
      "primary",
      async () => {
        await api(`/api/reviews/${encodeURIComponent(review.candidateId)}/confirm`, {
          method: "POST",
          body: "{}",
        });
        await renderReviews();
      },
      "check-circle",
    ),
  );
  panel.append(heading, compare, actions);
  return panel;
}

function consolidationReview(suggestion) {
  const panel = element("article", undefined, "review-panel consolidation-review");
  const heading = element("div", undefined, "review-heading");
  heading.append(
    element("h2", suggestion.kind === "merge" ? "知识整合建议" : "知识冲突"),
    element("span", suggestion.repoDisplayName, "muted"),
  );
  const compare = element("div", undefined, "compare consolidation-cards");
  compare.append(knowledgeCard(`主卡 · v${suggestion.target.version}`, suggestion.target.card));
  for (const related of suggestion.related) {
    compare.append(knowledgeCard(`相关卡 · v${related.version}`, related.card));
  }
  if (suggestion.proposedMemory) {
    compare.append(knowledgeCard("建议整合后", suggestion.proposedMemory));
  }
  const reason = element("p", `判断原因：${suggestion.reason}`, "review-reason muted");
  const actions = element("div", undefined, "actions");
  actions.append(
    actionButton("忽略建议", "secondary", async () => {
      await api(`/api/consolidations/${encodeURIComponent(suggestion.suggestionId)}/ignore`, {
        method: "POST",
        body: "{}",
      });
      await renderReviews();
    }),
  );
  if (suggestion.kind === "merge") {
    actions.append(
      actionButton(
        "确认整合",
        "primary",
        async () => {
          const result = await api(
            `/api/consolidations/${encodeURIComponent(suggestion.suggestionId)}/apply`,
            { method: "POST", body: "{}" },
          );
          if (result.state === "stale") {
            status.textContent = "知识版本已变化，本建议未应用";
          }
          await renderReviews();
        },
        "arrows-merge",
      ),
    );
  } else {
    actions.append(element("span", "冲突不会自动选择胜者", "muted"));
  }
  panel.append(heading, compare, reason, actions);
  return panel;
}

function knowledgeCard(label, card) {
  const node = element("div");
  node.append(
    element("h3", label),
    field("类型", card.kind),
    field("项目知识", card.knowledge),
    field("形成原因", card.rationale),
    field("适用场景", card.applicability),
  );
  return node;
}
