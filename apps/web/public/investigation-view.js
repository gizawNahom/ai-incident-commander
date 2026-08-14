export function buildInvestigationView(analysis) {
  const hypothesis = analysis.hypotheses?.[0];
  if (!hypothesis || !Array.isArray(analysis.knownEvidence)) throw new Error("Investigation response is incomplete");

  return {
    summary: analysis.summary,
    confidenceLabel: `${capitalize(hypothesis.confidence)} confidence`,
    inference: hypothesis.inference,
    evidence: analysis.knownEvidence
      .filter((item) => hypothesis.evidenceIds.includes(item.id))
      .map((item) => item.detail),
    uncertainty: analysis.uncertainty,
    action: analysis.suggestedAction
      ? {
          label: `Request rollback of ${analysis.suggestedAction.targetServiceId}`,
          status: "Proposed — not executed",
          rationale: analysis.suggestedAction.rationale,
          risk: `Risk: ${capitalize(analysis.suggestedAction.risk)}`,
        }
      : undefined,
  };
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
