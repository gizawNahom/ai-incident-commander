import assert from "node:assert/strict";
import test from "node:test";

import { GeminiGenerateContentTransport, GeminiInvestigator, type StructuredOutputTransport } from "../src/gemini-investigator.ts";
import type { InvestigationContext } from "../src/deterministic-investigator.ts";

const context: InvestigationContext = {
  incident: {
    id: "INC-77",
    title: "Storefront degradation",
    startedAt: "2026-08-14T12:00:20.000Z",
    affectedServices: ["orders-worker", "storefront"],
    alerts: [
      { id: "ALR-1", serviceId: "orders-worker", title: "Orders Worker latency above 1,000 ms", threshold: 1_000, observedValue: 1_430, unit: "ms", triggeredAt: "2026-08-14T12:00:10.000Z" },
      { id: "ALR-2", serviceId: "storefront", title: "Storefront error rate above 10%", threshold: 10, observedValue: 18, unit: "%", triggeredAt: "2026-08-14T12:00:20.000Z" },
    ],
    timeline: [
      { type: "DEPLOYMENT", timestamp: "2026-08-14T12:00:00.000Z", serviceId: "orders-worker", message: "orders-worker v9.0.0 deployment completed" },
      { type: "LOG", timestamp: "2026-08-14T12:00:12.000Z", serviceId: "orders-worker", message: "connection pool timeout while processing order" },
    ],
  },
  services: [
    { id: "storefront", name: "Storefront", dependencies: ["orders-worker"] },
    { id: "orders-worker", name: "Orders Worker", dependencies: ["queue-store"] },
    { id: "queue-store", name: "Queue Store", dependencies: [] },
  ],
  metricHistories: [{ serviceId: "orders-worker", samples: [{ timestamp: "2026-08-14T11:59:00.000Z", latencyMs: 120, errorRate: 0.2 }, { timestamp: "2026-08-14T12:00:20.000Z", latencyMs: 1_430, errorRate: 4.2 }] }],
};

test("accepts Gemini output only when citations and a rollback target are grounded in the evidence catalog", async () => {
  let requestEvidenceIds: readonly string[] = [];
  const transport: StructuredOutputTransport = {
    request: async (request) => {
      requestEvidenceIds = request.evidence.map((item) => item.id);
      return {
        summary: "Orders Worker is the likely source of Storefront degradation.",
        hypothesis: {
          targetServiceId: "orders-worker",
          confidence: "high",
          inference: "The deployment preceded latency growth and a connection-pool timeout.",
          evidenceIds: ["evidence-deployment", "evidence-orders-worker-latency", "evidence-log-1"],
        },
        uncertainty: "The evidence shows correlation, not source-code causation.",
        suggestedAction: {
          type: "ROLLBACK_DEPLOYMENT",
          targetServiceId: "orders-worker",
          evidenceIds: ["evidence-deployment"],
        },
      };
    },
  };

  const analysis = await new GeminiInvestigator(transport).investigate(context);

  assert.equal(analysis.source, "gemini");
  assert.ok(requestEvidenceIds.includes("evidence-deployment"));
  assert.equal(analysis.hypotheses[0].targetServiceId, "orders-worker");
  assert.equal(analysis.suggestedAction?.targetServiceId, "orders-worker");
});

test("rejects Gemini output that cites evidence absent from the catalog", async () => {
  const transport: StructuredOutputTransport = {
    request: async () => ({
      summary: "Unsupported claim",
      hypothesis: { targetServiceId: "orders-worker", confidence: "high", inference: "Unsupported claim", evidenceIds: ["invented-evidence"] },
      uncertainty: "Unknown",
    }),
  };

  await assert.rejects(() => new GeminiInvestigator(transport).investigate(context), /unknown evidence/i);
});

test("uses Gemini generateContent structured output and parses the candidate text", async () => {
  let requestedUrl = "";
  let requestedBody: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = input.toString();
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      summary: "Validated response",
      hypothesis: { targetServiceId: "orders-worker", confidence: "medium", inference: "Timed evidence", evidenceIds: ["evidence-deployment"] },
      uncertainty: "Correlation only",
      suggestedAction: null,
    }) }] } }] }), { status: 200 });
  };
  const transport = new GeminiGenerateContentTransport({ apiKey: "test-key", model: "gemini-2.5-flash-lite", fetchImpl });

  const result = await transport.request({ incidentId: "INC-77", incidentTitle: "Storefront degradation", affectedServiceIds: ["orders-worker"], serviceIds: ["orders-worker"], evidence: [{ id: "evidence-deployment", kind: "deployment", serviceId: "orders-worker", detail: "orders-worker deployed" }] });

  assert.equal(requestedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent");
  assert.deepEqual(result.hypothesis.evidenceIds, ["evidence-deployment"]);
  assert.ok(typeof requestedBody === "object" && requestedBody !== null);
  const body = requestedBody as { readonly generationConfig?: { readonly responseFormat?: { readonly text?: { readonly mimeType?: unknown } } } };
  assert.equal(body.generationConfig?.responseFormat?.text?.mimeType, "application/json");
});
