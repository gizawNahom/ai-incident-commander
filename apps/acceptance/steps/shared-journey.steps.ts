import { After, Before, Given, Then, When, setDefaultTimeout, setWorldConstructor } from "@cucumber/cucumber";

import { createIncidentCommanderDriver } from "../drivers/driver-factory.ts";
import type { IncidentCommanderDriver } from "../drivers/incident-commander-driver.ts";

class SharedJourneyWorld {
  driver: IncidentCommanderDriver | undefined;
}

setWorldConstructor(SharedJourneyWorld);
setDefaultTimeout(15_000);

Before({ tags: "@shared" }, async function (this: SharedJourneyWorld) {
  this.driver = createIncidentCommanderDriver();
  await this.driver.start();
});

After({ tags: "@shared" }, async function (this: SharedJourneyWorld, scenario) {
  await this.driver?.stop({ failed: scenario.result?.status === "FAILED" });
});

Given("the engineer opens a healthy Command Center", async function (this: SharedJourneyWorld) {
  await driver(this).openHealthyCommandCenter();
});

Then("the Command Center explains how to start a safe incident scenario", async function (this: SharedJourneyWorld) {
  await driver(this).assertSafeScenarioGuidance();
});

When("the engineer deploys the defective payment version", async function (this: SharedJourneyWorld) {
  await driver(this).deployDefectivePaymentVersion();
});

Then("a checkout degradation incident appears in the overview", async function (this: SharedJourneyWorld) {
  await driver(this).assertCheckoutDegradationIncident();
});

When("the engineer opens Payment Service from the Services inventory", async function (this: SharedJourneyWorld) {
  await driver(this).openPaymentService();
});

Then("they see critical live service health, alert evidence, logs, dependencies, and a related incident", async function (this: SharedJourneyWorld) {
  await driver(this).assertPaymentServiceContext();
});

When("the engineer opens the related Incident Room", async function (this: SharedJourneyWorld) {
  await driver(this).openRelatedIncidentRoom();
});

When("asks the AI Investigator to analyze the incident", async function (this: SharedJourneyWorld) {
  await driver(this).analyzeIncident();
});

Then("the investigator presents grounded deployment evidence", async function (this: SharedJourneyWorld) {
  await driver(this).assertGroundedDeploymentEvidence();
});

Then("proposes a rollback without changing the system", async function (this: SharedJourneyWorld) {
  await driver(this).assertRollbackProposedWithoutSystemChange();
});

When("the engineer takes incident command", async function (this: SharedJourneyWorld) {
  await driver(this).takeIncidentCommand();
});

Then("the incident records the engineer as commander", async function (this: SharedJourneyWorld) {
  await driver(this).assertIncidentCommander();
});

When("the incident commander approves the rollback", async function (this: SharedJourneyWorld) {
  await driver(this).approveRollback();
});

Then("Payment Service returns to its stable version", async function (this: SharedJourneyWorld) {
  await driver(this).assertPaymentReturnsToStableVersion();
});

Then("the incident enters recovery monitoring", async function (this: SharedJourneyWorld) {
  await driver(this).assertIncidentMonitoringRecovery();
});

When("the incident commander resolves the monitored incident", async function (this: SharedJourneyWorld) {
  await driver(this).resolveMonitoredIncident();
});

When("opens Incident History", async function (this: SharedJourneyWorld) {
  await driver(this).openIncidentHistory();
});

Then("the resolved incident is listed", async function (this: SharedJourneyWorld) {
  await driver(this).assertResolvedIncidentListed();
});

When("the engineer reopens the resolved Incident Room", async function (this: SharedJourneyWorld) {
  await driver(this).reopenResolvedIncidentRoom();
});

Then("the original deployment, metric spike, logs, mitigation, and resolution remain visible", async function (this: SharedJourneyWorld) {
  await driver(this).assertPreservedIncidentRecord();
});

function driver(world: SharedJourneyWorld): IncidentCommanderDriver {
  if (!world.driver) throw new Error("Shared journey driver was not initialized");
  return world.driver;
}
