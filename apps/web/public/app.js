import { buildTopologyGraph } from "./topology.js";
import { scenarioControl, serviceOutageRequest } from "./scenario-controls.js";

const byId = (id) => document.getElementById(id);
const elements = {
  activeIncidents: byId("active-incidents"),
  affected: byId("affected-services"),
  checkoutErrors: byId("checkout-errors"),
  description: byId("scenario-description"),
  detectionAlerts: byId("detection-alerts"),
  detectionMessage: byId("detection-message"),
  detectionPanel: byId("detection-panel"),
  eventCount: byId("event-count"),
  eventList: byId("event-list"),
  focus: byId("service-focus"),
  gatewayTraffic: byId("gateway-traffic"),
  health: byId("system-health"),
  incidentAlerts: byId("incident-alerts"),
  incidentPanel: byId("incident-panel"),
  incidentRoomLink: byId("incident-room-link"),
  incidentSeverity: byId("incident-severity"),
  incidentStatus: byId("incident-status"),
  incidentSubtitle: byId("incident-subtitle"),
  incidentTimeline: byId("incident-timeline"),
  incidentTitle: byId("incident-title"),
  paymentLatency: byId("payment-latency"),
  policyComparator: byId("policy-comparator"),
  policyDuration: byId("policy-duration"),
  policyEnabled: byId("policy-enabled"),
  policyError: byId("policy-form-error"),
  policyForm: byId("alert-policy-form"),
  policyFormMode: byId("policy-form-mode"),
  policyFormTitle: byId("policy-form-title"),
  policyList: byId("alert-policy-list"),
  policyMetric: byId("policy-metric"),
  policyName: byId("policy-name"),
  policyScope: byId("policy-scope"),
  policyServiceOptions: byId("policy-service-options"),
  policyServiceSelector: byId("policy-service-selector"),
  policySeverity: byId("policy-severity"),
  policyThreshold: byId("policy-threshold"),
  newPolicy: byId("new-policy"),
  outageTarget: byId("outage-target"),
  cancelPolicy: byId("cancel-policy"),
  recover: byId("recover-system"),
  redisLatency: byId("redis-latency"),
  scenario: byId("scenario-badge"),
  serviceGrid: byId("service-grid"),
  stream: byId("stream-status"),
  trigger: byId("trigger-deployment"),
  triggerKafka: byId("trigger-kafka-backlog"),
  triggerOutage: byId("trigger-service-outage"),
  triggerRedis: byId("trigger-redis-degradation"),
  updated: byId("updated-at"),
};

let system;
let incident;
let selectedServiceId = "payment-service";
let policies = [];
let editingPolicyId;
const events = [];

function getService(id) {
  return system?.services.find((service) => service.id === id);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function scenarioCopy(name) {
  if (name === "bad-payment-deployment") return "Defective payment-service v1.8.3 is degrading the checkout path.";
  if (name === "redis-degradation") return "Redis latency is rising and degrading its dependent request paths.";
  if (name === "kafka-backlog") return "Kafka consumer lag is delaying downstream event processing.";
  if (name === "service-outage") return "A simulated component outage is propagating through dependent services.";
  if (name === "recovering") return "Rollback is in progress. Dependency latency is returning to baseline.";
  return "All simulated services are operating within healthy baseline ranges.";
}

function renderSystem(nextSystem) {
  system = nextSystem;
  if (!getService(selectedServiceId)) selectedServiceId = system.services[0]?.id;
  const payment = getService("payment-service");
  const checkout = getService("checkout-service");
  const redis = getService("redis");
  const gateway = getService("api-gateway");
  const affected = system.services.filter((service) => service.health !== "healthy");
  const severity = affected.some((service) => service.health === "critical") ? "critical" : affected.length ? "degraded" : "healthy";

  elements.updated.textContent = `Updated ${new Date(system.timestamp).toLocaleTimeString()}`;
  elements.description.textContent = scenarioCopy(system.scenario);
  elements.scenario.textContent = system.scenario.replaceAll("-", " ");
  elements.health.textContent = severity[0].toUpperCase() + severity.slice(1);
  elements.health.className = severity;
  elements.affected.textContent = String(affected.length);
  elements.paymentLatency.textContent = formatNumber(payment.metrics.latencyMs);
  elements.checkoutErrors.textContent = formatNumber(checkout.metrics.errorRate);
  elements.redisLatency.textContent = formatNumber(redis.metrics.latencyMs);
  elements.gatewayTraffic.textContent = formatNumber(gateway.metrics.trafficRpm);
  renderOutageTargets();

  renderTopology();
  renderFocus();
  if (!elements.policyForm.hidden) renderServiceOptions();
}

function renderTopology() {
  const graph = buildTopologyGraph(system.services);
  const canvas = document.createElement("div");
  canvas.className = "topology-canvas";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("topology-lines");
  svg.setAttribute("viewBox", "0 0 1000 480");
  svg.setAttribute("aria-hidden", "true");
  const definitions = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "dependency-arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.classList.add("topology-arrow");
  marker.append(arrow);
  definitions.append(marker);
  svg.append(definitions);
  for (const edge of graph.edges) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const startX = edge.fromNode.x * 10 + 78;
    const startY = edge.fromNode.y * 4.8;
    const endX = edge.toNode.x * 10 - 78;
    const endY = edge.toNode.y * 4.8;
    const midpoint = (startX + endX) / 2;
    path.setAttribute("d", `M ${startX} ${startY} C ${midpoint} ${startY}, ${midpoint} ${endY}, ${endX} ${endY}`);
    path.setAttribute("marker-end", "url(#dependency-arrow)");
    path.classList.add("topology-edge", edge.health);
    svg.append(path);
  }
  canvas.append(svg);
  for (const service of graph.nodes) {
    const node = document.createElement("button");
    node.className = `service ${service.health}${selectedServiceId === service.id ? " selected" : ""}`;
    node.type = "button";
    node.style.left = `${service.x}%`;
    node.style.top = `${service.y}%`;
    node.innerHTML = `<small>${service.kind} · ${service.health}</small><strong>${service.name}</strong><span>${formatNumber(service.metrics.latencyMs)} ms p95</span>`;
    node.addEventListener("click", () => { selectedServiceId = service.id; renderTopology(); renderFocus(); });
    canvas.append(node);
  }
  elements.serviceGrid.replaceChildren(canvas);
}

function renderIncident(nextIncident) {
  incident = nextIncident;
  elements.activeIncidents.textContent = incident ? "1" : "0";
  if (!incident) {
    elements.incidentPanel.hidden = true;
    return;
  }
  elements.incidentPanel.hidden = false;
  elements.incidentTitle.textContent = `${incident.id} — ${incident.title}`;
  elements.incidentRoomLink.href = `/incident.html?id=${encodeURIComponent(incident.id)}`;
  elements.incidentSeverity.textContent = incident.severity;
  elements.incidentStatus.textContent = incident.status;
  elements.incidentSubtitle.textContent = `Created at ${new Date(incident.startedAt).toLocaleTimeString()} after correlated service alerts.`;
  elements.incidentAlerts.replaceChildren(...incident.alerts.map((alert) => {
    const item = document.createElement("li");
    item.textContent = `${alert.title}: ${formatNumber(alert.observedValue)}${alert.unit} observed`;
    return item;
  }));
  elements.incidentTimeline.replaceChildren(...incident.timeline.map((entry) => {
    const item = document.createElement("li");
    item.innerHTML = `<time>${new Date(entry.timestamp).toLocaleTimeString()}</time><span class="timeline-type">${entry.type.replaceAll("_", " ")}</span>${entry.message}`;
    return item;
  }));
}

function renderDetectionStatus(status) {
  const waiting = status.state === "WAITING_FOR_CORRELATED_EVIDENCE" && !incident;
  elements.detectionPanel.hidden = !waiting;
  if (!waiting) return;
  elements.detectionMessage.textContent = status.message;
  elements.detectionAlerts.replaceChildren(...status.activeAlerts.map((alert) => {
    const item = document.createElement("li");
    item.textContent = `${alert.title} · ${formatNumber(alert.observedValue)}${alert.unit} observed · ${alert.severity}`;
    return item;
  }));
}

async function refreshDetectionStatus() {
  try {
    const response = await fetch("/api/detection-status");
    if (!response.ok) throw new Error("Unable to load detection status");
    renderDetectionStatus(await response.json());
  } catch {
    elements.detectionPanel.hidden = true;
  }
}

function renderFocus() {
  const service = getService(selectedServiceId);
  if (!service) return;
  const dependencies = service.dependencies.length ? service.dependencies.join("  →  ") : "No direct dependencies";
  const queueLag = service.kind === "stream" || service.metrics.queueLag > 0
    ? `<div><span>Queue lag</span><strong>${formatNumber(service.metrics.queueLag)} messages</strong></div>`
    : "";
  elements.focus.innerHTML = `<h2>${service.name}</h2><p class="${service.health}">${service.health.toUpperCase()} · ${service.version}</p><div class="focus-metrics"><div><span>Latency</span><strong>${formatNumber(service.metrics.latencyMs)} ms</strong></div><div><span>Error rate</span><strong>${formatNumber(service.metrics.errorRate)}%</strong></div><div><span>Traffic</span><strong>${formatNumber(service.metrics.trafficRpm)} rpm</strong></div><div><span>CPU</span><strong>${formatNumber(service.metrics.cpuPercent)}%</strong></div>${queueLag}</div><div class="dependency-list">Dependencies<br>${dependencies}</div>`;
}

function renderOutageTargets() {
  if (!system) return;
  const selected = elements.outageTarget.value;
  elements.outageTarget.replaceChildren(...system.services.map((service) => {
    const option = document.createElement("option");
    option.value = service.id;
    option.textContent = service.name;
    return option;
  }));
  elements.outageTarget.value = system.services.some((service) => service.id === selected) ? selected : "payment-service";
}

function addEvent(event) {
  if (event.type === "telemetry" || event.type === "system") return;
  const normalized = event.type === "alert-triggered"
    ? { type: "alert", timestamp: event.alert.triggeredAt, level: "warn", message: `${event.alert.title} · ${event.alert.severity}` }
    : event.type === "incident-created"
      ? { type: "incident", timestamp: event.incident.startedAt, level: "error", message: `${event.incident.id} created: ${event.incident.title}` }
      : event;
  events.unshift(normalized);
  if (events.length > 8) events.pop();
  elements.eventCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  elements.eventList.replaceChildren(...events.map((item) => {
    const row = document.createElement("li");
    const level = item.type === "log" || item.type === "alert" || item.type === "incident" ? item.level : "";
    const message = item.message;
    row.innerHTML = `<time>${new Date(item.timestamp).toLocaleTimeString()}</time><span class="event-kind ${level}">${item.type}${level ? ` / ${level}` : ""}</span><span>${message}</span>`;
    return row;
  }));
}

function displayMetric(metric) {
  return ({ latencyMs: "latency", errorRate: "error rate", trafficRpm: "request volume", cpuPercent: "CPU utilization", queueLag: "queue lag" })[metric] ?? metric;
}

function displayScope(scope) {
  if (scope.type === "ALL_SERVICES") return "All monitored services";
  return scope.serviceIds.map((id) => getService(id)?.name ?? id).join(", ");
}

function renderPolicies(nextPolicies) {
  policies = nextPolicies;
  if (policies.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No alert policies are configured.";
    elements.policyList.replaceChildren(empty);
    return;
  }
  elements.policyList.replaceChildren(...policies.map((policy) => {
    const row = document.createElement("li");
    row.className = `policy-row${policy.enabled ? "" : " disabled"}`;
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = policy.name;
    const summary = document.createElement("p");
    const direction = policy.comparator === "GREATER_THAN" ? "above" : "below";
    const duration = policy.breachDurationSeconds === 0 ? "immediately" : `for ${policy.breachDurationSeconds}s`;
    summary.textContent = `${displayMetric(policy.metric)} ${direction} ${formatNumber(policy.threshold)} ${policy.unit} · ${duration}`;
    const scope = document.createElement("small");
    scope.textContent = displayScope(policy.scope);
    details.append(title, summary, scope);
    const controls = document.createElement("div");
    controls.className = "policy-row-controls";
    const state = document.createElement("span");
    state.className = `policy-state ${policy.enabled ? "enabled" : "disabled"}`;
    state.textContent = policy.enabled ? policy.severity : "Disabled";
    const edit = document.createElement("button");
    edit.className = "text-button";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openPolicyForm(policy));
    controls.append(state, edit);
    row.append(details, controls);
    return row;
  }));
}

function renderServiceOptions(selectedIds = []) {
  if (!system) return;
  const selected = new Set(selectedIds.length ? selectedIds : [...elements.policyServiceOptions.querySelectorAll("input:checked")].map((input) => input.value));
  elements.policyServiceOptions.replaceChildren(...system.services.map((service) => {
    const label = document.createElement("label");
    label.className = "service-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "serviceIds";
    checkbox.value = service.id;
    checkbox.checked = selected.has(service.id);
    const text = document.createElement("span");
    text.textContent = service.name;
    label.append(checkbox, text);
    return label;
  }));
}

function syncScopeSelector() {
  const selected = elements.policyScope.value === "SELECTED_SERVICES";
  elements.policyServiceSelector.hidden = !selected;
  if (selected) renderServiceOptions();
}

function openPolicyForm(policy) {
  editingPolicyId = policy?.id;
  elements.policyForm.hidden = false;
  elements.policyError.hidden = true;
  elements.policyError.textContent = "";
  elements.policyFormMode.textContent = policy ? "Edit detection rule" : "New detection rule";
  elements.policyFormTitle.textContent = policy ? "Edit alert policy" : "Create alert policy";
  elements.policyName.value = policy?.name ?? "";
  elements.policyMetric.value = policy?.metric ?? "latencyMs";
  elements.policyComparator.value = policy?.comparator ?? "GREATER_THAN";
  elements.policyThreshold.value = policy?.threshold ?? "";
  elements.policyDuration.value = policy?.breachDurationSeconds ?? 0;
  elements.policySeverity.value = policy?.severity ?? "SEV-2";
  elements.policyEnabled.checked = policy?.enabled ?? true;
  elements.policyScope.value = policy?.scope.type ?? "ALL_SERVICES";
  renderServiceOptions(policy?.scope.type === "SELECTED_SERVICES" ? policy.scope.serviceIds : []);
  syncScopeSelector();
  elements.policyName.focus();
}

function closePolicyForm() {
  editingPolicyId = undefined;
  elements.policyForm.hidden = true;
  elements.policyError.hidden = true;
}

function policyPayload() {
  const selectedServiceIds = [...elements.policyServiceOptions.querySelectorAll("input:checked")].map((input) => input.value);
  return {
    name: elements.policyName.value,
    metric: elements.policyMetric.value,
    comparator: elements.policyComparator.value,
    threshold: Number(elements.policyThreshold.value),
    breachDurationSeconds: Number(elements.policyDuration.value),
    severity: elements.policySeverity.value,
    enabled: elements.policyEnabled.checked,
    scope: elements.policyScope.value === "ALL_SERVICES"
      ? { type: "ALL_SERVICES" }
      : { type: "SELECTED_SERVICES", serviceIds: selectedServiceIds },
  };
}

async function savePolicy(event) {
  event.preventDefault();
  const method = editingPolicyId ? "PUT" : "POST";
  const path = editingPolicyId ? `/api/alert-policies/${encodeURIComponent(editingPolicyId)}` : "/api/alert-policies";
  const save = byId("save-policy");
  save.disabled = true;
  elements.policyError.hidden = true;
  try {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(policyPayload()) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Unable to save alert policy");
    const index = policies.findIndex((policy) => policy.id === payload.policy.id);
    const nextPolicies = index === -1 ? [...policies, payload.policy] : policies.map((policy) => policy.id === payload.policy.id ? payload.policy : policy);
    renderPolicies(nextPolicies);
    closePolicyForm();
    addEvent({ type: "policy", timestamp: new Date().toISOString(), level: "", message: `${payload.policy.name} is now active in the detector` });
    refreshDetectionStatus();
  } catch (error) {
    elements.policyError.textContent = error instanceof Error ? error.message : "Unable to save alert policy";
    elements.policyError.hidden = false;
  } finally {
    save.disabled = false;
  }
}

async function sendControl(control, button) {
  button.disabled = true;
  try {
    const response = await fetch(control.path, {
      method: control.method,
      ...(control.body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(control.body) } : {}),
    });
    if (!response.ok) throw new Error("Control request failed");
  } catch (error) {
    addEvent({ type: "log", timestamp: new Date().toISOString(), level: "error", message: error instanceof Error ? error.message : "Control request failed" });
  } finally {
    button.disabled = false;
  }
}

elements.trigger.addEventListener("click", () => sendControl(scenarioControl("bad-payment-deployment"), elements.trigger));
elements.triggerRedis.addEventListener("click", () => sendControl(scenarioControl("redis-degradation"), elements.triggerRedis));
elements.triggerKafka.addEventListener("click", () => sendControl(scenarioControl("kafka-backlog"), elements.triggerKafka));
elements.triggerOutage.addEventListener("click", () => sendControl(serviceOutageRequest(elements.outageTarget.value), elements.triggerOutage));
elements.recover.addEventListener("click", () => sendControl({ method: "POST", path: "/api/simulator/recover" }, elements.recover));
elements.newPolicy.addEventListener("click", () => openPolicyForm(undefined));
elements.cancelPolicy.addEventListener("click", closePolicyForm);
elements.policyScope.addEventListener("change", syncScopeSelector);
elements.policyForm.addEventListener("submit", savePolicy);

fetch("/api/system").then((response) => response.json()).then(renderSystem).catch(() => { elements.description.textContent = "Unable to load the simulator snapshot."; });
fetch("/api/incidents").then((response) => response.json()).then((payload) => renderIncident(payload.incidents[0])).catch(() => renderIncident(undefined));
refreshDetectionStatus();
fetch("/api/alert-policies").then((response) => response.json()).then((payload) => renderPolicies(payload.policies)).catch(() => {
  const error = document.createElement("li");
  error.className = "empty";
  error.textContent = "Unable to load alert policies.";
  elements.policyList.replaceChildren(error);
});
const liveEvents = new EventSource("/api/events");
liveEvents.addEventListener("open", () => { elements.stream.textContent = "Streaming"; });
liveEvents.addEventListener("system", (event) => { renderSystem(JSON.parse(event.data).system); refreshDetectionStatus(); });
liveEvents.addEventListener("deployment", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("log", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("alert-triggered", (event) => { addEvent(JSON.parse(event.data)); refreshDetectionStatus(); });
liveEvents.addEventListener("incident-created", (event) => {
  const change = JSON.parse(event.data);
  addEvent(change);
  renderIncident(change.incident);
  refreshDetectionStatus();
});
liveEvents.addEventListener("error", () => { elements.stream.textContent = "Reconnecting"; });
