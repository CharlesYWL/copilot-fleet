import {
  DriClassificationSchema,
  DriRoutingInputSchema,
  parseIcmReference,
  type DriClassification,
} from "@fleet/protocol";

/** Classifies intent only. Team/profile selection still requires ingested ownership evidence. */
export function classifyDriRequest(input: unknown): DriClassification {
  const request = DriRoutingInputSchema.parse(input);
  const text = request.objective.normalize("NFKC").slice(0, 4_000);
  const intent = text
    .trim()
    .replace(
      /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|I (?:need|want) (?:you to|to)\s+){1,3}/i,
      "",
    );
  const structured = request.dri?.icm ? parseIcmReference(request.dri.icm) : undefined;
  const references = new Map<string, ReturnType<typeof parseIcmReference>>();
  let hasUrl = false;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const candidate = match[0].replace(/[),.;!?]+$/, "");
    try {
      const reference = parseIcmReference(candidate);
      references.set(reference.id, reference);
      hasUrl = true;
    } catch {
      // An unapproved URL is data, not an incident reference or a tool endpoint.
    }
  }
  for (const match of text.matchAll(
    /\bicm\s*(?:incident\s*)?(?:id\s*[:#]?\s*|[:#]\s*)?([1-9]\d{0,17})(?![\w])/gi,
  )) {
    const reference = parseIcmReference(match[1]!);
    references.set(reference.id, reference);
  }
  const candidateIncidentId =
    /\bincident\s*(?:id\s*[:#]?\s*|[:#]\s*)?([1-9]\d{0,17})(?![\w])/i.exec(text)?.[1];
  const incident =
    structured ?? (references.size === 1 ? [...references.values()][0] : undefined);
  const explicitIntent = /\bdri\s+investigation\b|\binvestigate\s+(?:the\s+)?icm\b/i.test(
    text,
  );
  const diagnostic =
    /\binvestigat(?:e|ion|ing)\b|\bdri\b|\broot[\s-]+cause\b|\btelemetry\b|\bhar\b/i.test(
      text,
    );
  const implementation =
    (/^(?:update|edit|write|document|implement|refactor|add|remove|rename|translate|test|build|create|fix|improve|repair)\b/i.test(
      intent,
    ) &&
      /\breadme\b|\bdocs?\b|\bdocumentation\b|\binstructions\b|\bguide\b|\bexamples?\b|\btests?\b|\bcode\b|\bclassifier\b|\bparser\b|\brouting\b|\bui\b|\bcomponent\b|\bcoordinator\b|\bworkflow\b|\bfunction\b|\bapi\b/i.test(
        text,
      )) ||
    /^(?:please\s+)?(?:explain|show|describe|document)\b[\s\S]{0,160}\b(?:how to|examples?|instructions)\b/i.test(
      intent,
    ) ||
    /\b(?:do not|don't|never|avoid)\s+(?:investigat(?:e|ing)|analy[sz]e)\b/i.test(text);
  const suggestedEvidence: DriClassification["suggestedEvidence"] = ["incident"];
  if (request.dri?.artifactRef || /\bhar\b/i.test(text)) suggestedEvidence.push("har");
  if (/\btelemetry\b|\bkusto\b|\blogs\b/i.test(text)) suggestedEvidence.push("telemetry");
  if (/\bsimilar\b|\bprevious\s+incidents?\b/i.test(text))
    suggestedEvidence.push("similar");
  if (/\bdeployments?\b|\bpipelines?\b|\bcommits?\b/i.test(text))
    suggestedEvidence.push("change");

  const result = (
    route: DriClassification["route"],
    confidence: number,
    reason: DriClassification["reasons"][number],
    explanation: string,
  ): DriClassification =>
    DriClassificationSchema.parse({
      route,
      confidence,
      source: request.workflow === "auto" ? "detected" : "explicit",
      reasons: [reason],
      explanation,
      ...(incident ? { incident } : {}),
      ...(candidateIncidentId ? { candidateIncidentId } : {}),
      suggestedProfile: "auto",
      suggestedEvidence: route === "regular" ? [] : suggestedEvidence,
      requiresConfirmation: route === "ambiguous",
      needsIncident: route !== "regular" && !incident,
    });

  if (request.workflow === "regular")
    return result(
      "regular",
      1,
      "explicit_regular",
      "Regular workflow selected. Automatic DRI detection is overridden.",
    );
  if (request.workflow === "dri")
    return result(
      "dri",
      1,
      "explicit_dri",
      incident
        ? "DRI investigation selected. Only configured read-only evidence providers will be used."
        : "DRI investigation selected. Confirm one ICM ID or approved incident URL before creation.",
    );
  if (implementation)
    return result(
      "regular",
      0.99,
      "implementation_task",
      "This asks for a code, test, or documentation change, not an operational investigation.",
    );
  if (
    /^(?:investigate|debug|check)\b/i.test(intent) &&
    /\breadme\b|\bunit tests?\b|\bclassifier\b|\bparser\b|\brouting (?:code|logic)\b/i.test(
      text,
    )
  )
    return result(
      "ambiguous",
      0.6,
      "implementation_task",
      "This may be a code/documentation investigation rather than an operational incident. Choose Regular or DRI investigation.",
    );
  if (structured)
    return result(
      "dri",
      0.99,
      "structured_icm",
      "Structured ICM input identifies an investigation. Profile selection follows verified incident ingestion.",
    );
  if (references.size > 1)
    return result(
      "ambiguous",
      0.5,
      "multiple_incidents",
      "Several ICM incidents are referenced. Choose one incident and confirm the workflow.",
    );
  if (hasUrl)
    return result(
      "dri",
      0.98,
      "icm_url",
      "An approved ICM incident URL identifies a read-only investigation.",
    );
  if (incident && diagnostic)
    return result(
      "dri",
      0.98,
      "icm_investigation",
      "An explicit ICM ID and investigation intent identify a read-only DRI workflow.",
    );
  if (explicitIntent)
    return result(
      "dri",
      0.97,
      "explicit_intent",
      "Explicit DRI intent detected. Confirm an ICM reference before collecting evidence.",
    );
  if (candidateIncidentId && diagnostic)
    return result(
      "ambiguous",
      0.6,
      "unconfirmed_incident",
      "Investigation intent detected, but the incident system is unknown. Confirm ICM or choose Regular.",
    );
  if (incident)
    return result(
      "ambiguous",
      0.6,
      "insufficient_intent",
      "An ICM reference alone does not establish the intended workflow. Choose DRI investigation or Regular.",
    );
  if (
    /\binvestigate\b/i.test(text) &&
    /\bincident\b|\bicm\b|\btelemetry\b|\bhar\b/i.test(text)
  )
    return result(
      "ambiguous",
      0.5,
      "missing_reference",
      "This may be an incident investigation. Confirm the workflow and an ICM reference.",
    );
  return result(
    "regular",
    0.95,
    "regular_request",
    "No strong DRI investigation intent detected. The regular orchestration workflow is unchanged.",
  );
}
