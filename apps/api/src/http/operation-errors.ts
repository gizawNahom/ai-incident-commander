import { IncidentOperationError, type IncidentFailureKind } from "../incident-manager.ts";
import { RequestBodyError, sendError, type RequestContext } from "./http-kit.ts";

const statuses: Record<IncidentFailureKind, number> = { "not-found": 404, forbidden: 403, conflict: 409 };

// Incident operations report refusals by kind; invalid operation input is currently reported as a conflict.
export function sendOperationError(context: RequestContext, error: unknown, fallbackMessage: string): void {
  if (error instanceof IncidentOperationError) {
    sendError(context, statuses[error.kind], error.message);
    return;
  }
  sendError(context, 409, error instanceof RequestBodyError ? error.message : fallbackMessage);
}
