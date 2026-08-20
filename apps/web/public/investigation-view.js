export function buildInvestigationView(analysis, actions = []) {
  const hypothesis = analysis.hypotheses?.[0];
  if (!hypothesis || !Array.isArray(analysis.knownEvidence)) throw new Error("Investigation response is incomplete");

  return {
    sourceLabel: sourceLabel(analysis),
    summary: analysis.summary,
    confidenceLabel: `${capitalize(hypothesis.confidence)} confidence`,
    inference: hypothesis.inference,
    evidence: analysis.knownEvidence
      .filter((item) => hypothesis.evidenceIds.includes(item.id))
      .map((item) => item.detail),
    uncertainty: analysis.uncertainty,
    action: actionView(analysis.suggestedAction, actions),
  };
}

function actionView(recommendation, actions) {
  if (!recommendation) return undefined;
  const action = actions.find((candidate) => candidate.type === recommendation.type && candidate.targetServiceId === recommendation.targetServiceId && candidate.fromVersion === recommendation.fromVersion && candidate.toVersion === recommendation.toVersion) ?? recommendation;
  return {
    id: action.id,
    label: `Rollback ${action.targetServiceId}`,
    versionChange: `${action.fromVersion} → ${action.toVersion}`,
    status: actionStatusLabel(action.status),
    rationale: action.reasoning ?? action.rationale,
    risk: `Risk: ${capitalize(action.risk)}`,
    canDecide: action.status === "PROPOSED" && Boolean(action.id),
    decisionReason: action.decisionReason,
    outcome: action.outcome,
  };
}

function actionStatusLabel(status) {
  return ({
    PROPOSED: "Proposed — approval required",
    APPROVED: "Approved — starting rollback",
    REJECTED: "Rejected — no system change",
    EXECUTING: "Rollback in progress",
    COMPLETED: "Rollback completed — monitoring recovery",
    FAILED: "Rollback failed",
  })[status] ?? "Proposed — approval required";
}

function sourceLabel(analysis) {
  if (analysis.source === "gemini") return "Gemini-assisted · citations validated";
  if (analysis.fallbackReason) return "Offline fallback · provider unavailable";
  return "Deterministic evidence analysis";
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
