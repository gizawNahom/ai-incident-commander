import {
  DeterministicInvestigator,
  type IncidentInvestigator,
  type Investigation,
  type InvestigationContext,
  type InvestigationHypothesis,
  type KnownEvidence,
  type ProposedMitigation,
} from "./deterministic-investigator.ts";

type Confidence = InvestigationHypothesis["confidence"];

export type AiInvestigationOutput = {
  readonly summary: string;
  readonly hypothesis: {
    readonly targetServiceId: string;
    readonly confidence: Confidence;
    readonly inference: string;
    readonly evidenceIds: readonly string[];
  };
  readonly uncertainty: string;
  readonly suggestedAction?: {
    readonly type: "ROLLBACK_DEPLOYMENT";
    readonly targetServiceId: string;
    readonly evidenceIds: readonly string[];
  };
};

export type StructuredOutputRequest = {
  readonly incidentId: string;
  readonly incidentTitle: string;
  readonly affectedServiceIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly evidence: readonly KnownEvidence[];
};

export interface StructuredOutputTransport {
  request(request: StructuredOutputRequest): Promise<AiInvestigationOutput>;
}

export class GeminiInvestigator implements IncidentInvestigator {
  private readonly transport: StructuredOutputTransport;
  private readonly deterministic: DeterministicInvestigator;

  constructor(transport: StructuredOutputTransport, deterministic = new DeterministicInvestigator()) {
    this.transport = transport;
    this.deterministic = deterministic;
  }

  async investigate(context: InvestigationContext): Promise<Investigation> {
    const baseline = this.deterministic.investigate(context);
    const output = await this.transport.request({
      incidentId: context.incident.id,
      incidentTitle: context.incident.title,
      affectedServiceIds: context.incident.affectedServices,
      serviceIds: context.services.map((service) => service.id),
      evidence: baseline.knownEvidence,
    });
    return validateAiInvestigation(output, baseline);
  }
}

export class GeminiGenerateContentTransport implements StructuredOutputTransport {
  private readonly options: { readonly apiKey: string; readonly model: string; readonly fetchImpl?: typeof fetch };

  constructor(options: { readonly apiKey: string; readonly model: string; readonly fetchImpl?: typeof fetch }) {
    this.options = options;
  }

  async request(request: StructuredOutputRequest): Promise<AiInvestigationOutput> {
    const response = await (this.options.fetchImpl ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.options.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You investigate incidents. Use only supplied evidence IDs. Do not claim unsupported facts or execute actions. Return the required JSON." }],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(request) }] }],
        generationConfig: { responseFormat: { text: { mimeType: "application/json", schema: investigationSchema } } },
      }),
    });
    if (!response.ok) throw new Error(`Gemini request failed with status ${response.status}`);
    return parseAiInvestigation(extractCandidateText(await response.json()));
  }
}

const investigationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "hypothesis", "uncertainty", "suggestedAction"],
  properties: {
    summary: { type: "string" },
    hypothesis: {
      type: "object",
      additionalProperties: false,
      required: ["targetServiceId", "confidence", "inference", "evidenceIds"],
      properties: {
        targetServiceId: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        inference: { type: "string" },
        evidenceIds: { type: "array", items: { type: "string" } },
      },
    },
    uncertainty: { type: "string" },
    suggestedAction: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["type", "targetServiceId", "evidenceIds"],
      properties: {
        type: { type: "string", enum: ["ROLLBACK_DEPLOYMENT"] },
        targetServiceId: { type: "string" },
        evidenceIds: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

function validateAiInvestigation(output: AiInvestigationOutput, baseline: Investigation): Investigation {
  const evidenceById = new Map(baseline.knownEvidence.map((evidence) => [evidence.id, evidence]));
  assertNonEmptyText(output.summary, "summary");
  assertNonEmptyText(output.uncertainty, "uncertainty");
  assertNonEmptyText(output.hypothesis.inference, "hypothesis inference");
  assertKnownService(output.hypothesis.targetServiceId, baseline.knownEvidence);
  assertConfidence(output.hypothesis.confidence);
  assertKnownEvidence(output.hypothesis.evidenceIds, evidenceById);
  const suggestedAction = output.suggestedAction ? validateSuggestedAction(output.suggestedAction, evidenceById, baseline.suggestedAction) : undefined;
  return {
    source: "gemini",
    summary: output.summary,
    knownEvidence: baseline.knownEvidence,
    hypotheses: [{ ...output.hypothesis }],
    uncertainty: output.uncertainty,
    suggestedAction,
  };
}

function validateSuggestedAction(action: NonNullable<AiInvestigationOutput["suggestedAction"]>, evidenceById: ReadonlyMap<string, KnownEvidence>, baselineAction: ProposedMitigation | undefined): ProposedMitigation {
  assertKnownEvidence(action.evidenceIds, evidenceById);
  const deployment = action.evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId))
    .find((evidence) => evidence?.kind === "deployment" && evidence.serviceId === action.targetServiceId);
  if (!deployment) throw new Error("AI suggested a rollback without a matching deployment evidence item");
  if (!baselineAction || baselineAction.targetServiceId !== action.targetServiceId) throw new Error("AI suggested a rollback without a rollback-safe deployment version pair");
  return {
    type: "ROLLBACK_DEPLOYMENT",
    targetServiceId: action.targetServiceId,
    fromVersion: baselineAction.fromVersion,
    toVersion: baselineAction.toVersion,
    status: "PROPOSED",
    risk: "medium",
    rationale: "The deployment immediately preceded the observed degradation.",
  };
}

function assertKnownService(serviceId: string, evidence: readonly KnownEvidence[]): void {
  if (!evidence.some((item) => item.serviceId === serviceId)) throw new Error(`AI referenced an unknown service: ${serviceId}`);
}

function assertKnownEvidence(evidenceIds: readonly string[], evidenceById: ReadonlyMap<string, KnownEvidence>): void {
  if (evidenceIds.length === 0) throw new Error("AI response must cite at least one evidence item");
  for (const evidenceId of evidenceIds) {
    if (!evidenceById.has(evidenceId)) throw new Error(`AI cited unknown evidence: ${evidenceId}`);
  }
}

function assertConfidence(value: string): asserts value is Confidence {
  if (value !== "high" && value !== "medium" && value !== "low") throw new Error(`AI returned an invalid confidence: ${value}`);
}

function assertNonEmptyText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`AI returned an empty ${field}`);
}

function extractCandidateText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) throw new Error("Gemini response did not contain candidates");
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    for (const part of candidate.content.parts) {
      if (isRecord(part) && typeof part.text === "string") return part.text;
    }
  }
  throw new Error("Gemini response did not contain text output");
}

function parseAiInvestigation(text: string): AiInvestigationOutput {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Gemini response was not valid JSON");
  }
  if (!isRecord(payload) || !isRecord(payload.hypothesis) || !Array.isArray(payload.hypothesis.evidenceIds)) throw new Error("Gemini response did not match the investigation schema");
  if (typeof payload.summary !== "string" || typeof payload.uncertainty !== "string" || typeof payload.hypothesis.targetServiceId !== "string" || typeof payload.hypothesis.confidence !== "string" || typeof payload.hypothesis.inference !== "string" || !payload.hypothesis.evidenceIds.every(isString)) throw new Error("Gemini response did not match the investigation schema");
  const suggestedAction = parseSuggestedAction(payload.suggestedAction);
  return {
    summary: payload.summary,
    hypothesis: {
      targetServiceId: payload.hypothesis.targetServiceId,
      confidence: payload.hypothesis.confidence as Confidence,
      inference: payload.hypothesis.inference,
      evidenceIds: payload.hypothesis.evidenceIds,
    },
    uncertainty: payload.uncertainty,
    suggestedAction,
  };
}

function parseSuggestedAction(value: unknown): AiInvestigationOutput["suggestedAction"] {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value) || value.type !== "ROLLBACK_DEPLOYMENT" || typeof value.targetServiceId !== "string" || !Array.isArray(value.evidenceIds) || !value.evidenceIds.every(isString)) throw new Error("Gemini response did not match the investigation schema");
  return { type: "ROLLBACK_DEPLOYMENT", targetServiceId: value.targetServiceId, evidenceIds: value.evidenceIds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
