export interface IncidentCommanderDriver {
  start(): Promise<void>;
  stop(options: { readonly failed: boolean }): Promise<void>;
  openHealthyCommandCenter(): Promise<void>;
  assertSafeScenarioGuidance(): Promise<void>;
  deployDefectivePaymentVersion(): Promise<void>;
  assertCheckoutDegradationIncident(): Promise<void>;
  openPaymentService(): Promise<void>;
  assertPaymentServiceContext(): Promise<void>;
  openRelatedIncidentRoom(): Promise<void>;
  analyzeIncident(): Promise<void>;
  assertGroundedDeploymentEvidence(): Promise<void>;
  assertRollbackProposedWithoutSystemChange(): Promise<void>;
  takeIncidentCommand(): Promise<void>;
  assertIncidentCommander(): Promise<void>;
  approveRollback(): Promise<void>;
  assertPaymentReturnsToStableVersion(): Promise<void>;
  assertIncidentMonitoringRecovery(): Promise<void>;
  resolveMonitoredIncident(): Promise<void>;
  openIncidentHistory(): Promise<void>;
  assertResolvedIncidentListed(): Promise<void>;
  reopenResolvedIncidentRoom(): Promise<void>;
  assertPreservedIncidentRecord(): Promise<void>;
}
