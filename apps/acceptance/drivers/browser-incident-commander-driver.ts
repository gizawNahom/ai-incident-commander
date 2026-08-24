import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { createServer } from "../../api/src/server.ts";

import type { IncidentCommanderDriver } from "./incident-commander-driver.ts";

type Application = ReturnType<typeof createServer>;

export class BrowserIncidentCommanderDriver implements IncidentCommanderDriver {
  private app: Application | undefined;
  private address: string | undefined;
  private browser: Browser | undefined;
  private page: Page | undefined;
  private incidentUrl: string | undefined;

  async start(): Promise<void> {
    this.app = createServer({ tickIntervalMs: 1_000 });
    this.address = await this.app.listen();
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();
  }

  async stop(options: { readonly failed: boolean }): Promise<void> {
    if (options.failed && this.page) {
      const directory = "/tmp/ai-incident-commander-e2e";
      await mkdir(directory, { recursive: true });
      const screenshot = join(directory, `shared-incident-journey-${Date.now()}.png`);
      await this.page.screenshot({ path: screenshot, fullPage: true });
      process.stderr.write(`Browser failure screenshot: ${screenshot}\n`);
    }
    await this.browser?.close();
    await this.app?.close();
  }

  async openHealthyCommandCenter(): Promise<void> {
    await this.pageValue().goto(this.baseUrl());
    const health = this.pageValue().locator("#system-health");
    await health.waitFor({ state: "visible" });
    assert.equal((await health.textContent())?.trim(), "Healthy");
  }

  async deployDefectivePaymentVersion(): Promise<void> {
    await this.pageValue().getByRole("button", { name: "Deploy bad payment version" }).click();
  }

  async assertCheckoutDegradationIncident(): Promise<void> {
    const card = this.pageValue().locator(".incident-card");
    await card.filter({ hasText: "Checkout Service degradation" }).waitFor({ state: "visible", timeout: 8_000 });
  }

  async openPaymentService(): Promise<void> {
    await this.pageValue().getByRole("link", { name: "Services" }).click();
    const paymentRow = this.pageValue().locator("tr").filter({ hasText: "Payment Service" });
    await paymentRow.waitFor({ state: "visible" });
    await paymentRow.getByRole("link", { name: "Inspect →" }).click();
  }

  async assertPaymentServiceContext(): Promise<void> {
    const page = this.pageValue();
    await page.getByRole("heading", { name: "Payment Service" }).waitFor({ state: "visible" });
    await page.getByText(/CRITICAL now/).waitFor({ state: "visible", timeout: 8_000 });
    for (const heading of ["Recent logs", "Dependencies", "Active alerts", "Related incidents"]) {
      await page.getByRole("heading", { name: heading }).waitFor({ state: "visible" });
    }
    await page.getByRole("link", { name: /INC-1042/ }).waitFor({ state: "visible" });
  }

  async openRelatedIncidentRoom(): Promise<void> {
    const link = this.pageValue().getByRole("link", { name: /INC-1042/ });
    await link.click();
    await this.pageValue().getByRole("heading", { name: /INC-1042/ }).waitFor({ state: "visible" });
    this.incidentUrl = this.pageValue().url();
  }

  async analyzeIncident(): Promise<void> {
    await this.pageValue().getByRole("button", { name: "Analyze incident" }).click();
  }

  async assertGroundedDeploymentEvidence(): Promise<void> {
    const page = this.pageValue();
    await page.getByRole("heading", { name: "Primary hypothesis" }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Known evidence" }).waitFor({ state: "visible" });
    await page.locator(".investigation-evidence").getByText("payment-service v1.8.3 deployment completed", { exact: true }).waitFor({ state: "visible" });
  }

  async assertRollbackProposedWithoutSystemChange(): Promise<void> {
    const page = this.pageValue();
    const action = page.locator(".proposed-action");
    await action.waitFor({ state: "visible" });
    const actionText = await action.innerText();
    assert.match(actionText, /proposed — approval required/i);
    assert.match(actionText, /v1\.8\.3 → v1\.8\.2/i);
    await page.getByRole("button", { name: "Approve rollback" }).waitFor({ state: "visible" });
  }

  async approveRollback(): Promise<void> {
    await this.pageValue().getByRole("button", { name: "Approve rollback" }).click();
  }

  async assertPaymentReturnsToStableVersion(): Promise<void> {
    const page = this.pageValue();
    await page.getByRole("link", { name: "Services" }).click();
    const paymentRow = page.locator("tr").filter({ hasText: "Payment Service" });
    await paymentRow.getByRole("link", { name: "Inspect →" }).click();
    await page.getByRole("heading", { name: "Payment Service" }).waitFor({ state: "visible" });
    assert.match((await page.locator("#service-summary").innerText()), /v1\.8\.2/);
    await page.getByRole("link", { name: /INC-1042/ }).click();
    await page.getByRole("heading", { name: /INC-1042/ }).waitFor({ state: "visible" });
  }

  async assertIncidentMonitoringRecovery(): Promise<void> {
    await this.pageValue().locator("#room-status").getByText("MONITORING", { exact: true }).waitFor({ state: "visible", timeout: 8_000 });
  }

  async resolveMonitoredIncident(): Promise<void> {
    await this.pageValue().getByRole("button", { name: "Resolve incident" }).click();
    await this.pageValue().locator("#room-status").getByText("RESOLVED", { exact: true }).waitFor({ state: "visible" });
  }

  async openIncidentHistory(): Promise<void> {
    await this.pageValue().getByRole("link", { name: "Incident History" }).click();
    await this.pageValue().getByRole("heading", { name: "Incident records" }).waitFor({ state: "visible" });
  }

  async assertResolvedIncidentListed(): Promise<void> {
    const row = this.pageValue().locator("tr").filter({ hasText: "INC-1042" });
    await row.waitFor({ state: "visible" });
    await row.getByText("RESOLVED", { exact: true }).waitFor({ state: "visible" });
  }

  async reopenResolvedIncidentRoom(): Promise<void> {
    const row = this.pageValue().locator("tr").filter({ hasText: "INC-1042" });
    await row.getByRole("link", { name: "Open room →" }).click();
    await this.pageValue().getByRole("heading", { name: /INC-1042/ }).waitFor({ state: "visible" });
    assert.equal(this.pageValue().url(), this.incidentUrl);
  }

  async assertPreservedIncidentRecord(): Promise<void> {
    const page = this.pageValue();
    await page.locator("#room-timeline").getByText("payment-service v1.8.3 deployment completed", { exact: true }).waitFor({ state: "visible" });
    await page.locator("#room-logs").getByText(/connection pool timeout/).first().waitFor({ state: "visible" });
    await page.locator("#room-timeline").getByText("ACTION COMPLETED", { exact: true }).waitFor({ state: "visible" });
    await page.locator("#room-timeline").getByText("INCIDENT RESOLVED", { exact: true }).waitFor({ state: "visible" });
    assert.ok(await page.locator(".metric-chart i").count() > 0, "Expected preserved incident metric bars");
  }

  private pageValue(): Page {
    if (!this.page) throw new Error("Browser test page is not available");
    return this.page;
  }

  private baseUrl(): string {
    if (!this.address) throw new Error("Browser test application is not listening");
    return this.address;
  }
}
