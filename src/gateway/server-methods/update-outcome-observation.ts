import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { formatControlPlaneActor, type ControlPlaneActor } from "../control-plane-audit.js";
import type { GatewayRequestContext } from "./types.js";

/** Project an admitted update's current outcome to the host log and private report. */
export async function recordGatewayUpdateOutcome(
  result: UpdateRunResult,
  run: UpdateRunRecord,
  runId: string,
  actor: ControlPlaneActor,
  logGateway: GatewayRequestContext["logGateway"],
): Promise<void> {
  const outcome = classifyUpdateOutcome(result);
  const publicReason =
    result.reason &&
    (await import("../../infra/update-failure-public-identifiers.js")).isPublicUpdateFailureCode(
      result.reason,
    )
      ? result.reason
      : "unavailable";
  const message = `update.run ${outcome === "pending" ? "handoff started" : outcome === "failed" ? "failed" : "completed"} runId=${runId} status=${outcome ?? result.status} reason=${publicReason} ${formatControlPlaneActor(actor)}`;
  if (outcome !== "failed") {
    logGateway?.info(message);
    return;
  }
  logGateway?.warn(message);
  try {
    const { refreshUpdateRunReportArtifact } =
      await import("../../infra/update-failure-report-artifact.js");
    await refreshUpdateRunReportArtifact(run);
  } catch {
    // The run ledger is already committed; reporting must not replace its result.
    logGateway?.warn(`update.run report could not be saved runId=${runId}`);
  }
}
