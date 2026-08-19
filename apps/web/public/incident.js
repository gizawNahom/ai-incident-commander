import { buildTopologyGraph } from "./topology.js";
import { buildInvestigationView } from "./investigation-view.js";
import { selectIncidentMetricCards } from "./incident-metrics.js";

const incidentId = new URLSearchParams(window.location.search).get("id");
const elements = {
  alerts: document.getElementById("room-alerts"),
  error: document.getElementById("room-error"),
  header: document.getElementById("room-header"),
  logs: document.getElementById("room-logs"),
  metrics: document.getElementById("room-metrics"),
  services: document.getElementById("room-services"),
  severity: document.getElementById("room-severity"),
  status: document.getElementById("room-status"),
  summary: document.getElementById("room-summary"),
  timeline: document.getElementById("room-timeline"),
  timelineCount: document.getElementById("timeline-count"),
  topology: document.getElementById("room-topology"),
  workbench: document.getElementById("room-workbench"),
  evidence: document.getElementById("room-evidence"),
  alertCount: document.getElementById("room-alert-count"),
  investigateButton: document.getElementById("investigate-button"),
  investigator: document.getElementById("room-investigator"),
  investigationResult: document.getElementById("investigation-result"),
  liveState: document.getElementById("room-live-state"),
};

let incident;
let system;
let evidence;

function format(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Unable to load incident evidence");
  return response.json();
}

function showError(message) {
  elements.error.hidden = false;
  elements.error.textContent = message;
}

function renderIncident(nextIncident) {
  incident = nextIncident;
  elements.header.innerHTML = `<p class="eyebrow">Incident room / live investigation</p><h1>${incident.id} — ${incident.title}</h1><p>Preserved incident evidence is separate from the current system state.</p><p id="room-live-state">Connecting to live system state…</p>`;
  elements.liveState = document.getElementById("room-live-state");
  elements.severity.textContent = incident.severity;
  elements.status.textContent = incident.status;
  elements.services.textContent = incident.affectedServices.length;
  elements.alertCount.textContent = incident.alerts.length;
  elements.alerts.replaceChildren(...incident.alerts.map((alert) => {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${alert.title}</strong><span>${format(alert.observedValue)}${alert.unit} observed · threshold ${alert.threshold}${alert.unit}</span>`;
    return item;
  }));
  renderTimeline();
  elements.summary.hidden = false;
  elements.workbench.hidden = false;
  elements.metrics.hidden = false;
  elements.evidence.hidden = false;
  elements.investigator.hidden = false;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function renderInvestigation(analysis) {
  const view = buildInvestigationView(analysis);
  const source = element("span", "analysis-source", view.sourceLabel);
  const summary = element("p", "investigation-summary", view.summary);
  const hypothesis = element("article", "hypothesis-card");
  hypothesis.append(element("span", "confidence", view.confidenceLabel), element("h3", "", "Primary hypothesis"), element("p", "", view.inference));
  const evidenceHeading = element("h4", "", "Known evidence");
  const evidence = element("ul", "investigation-evidence");
  evidence.append(...view.evidence.map((detail) => element("li", "", detail)));
  hypothesis.append(evidenceHeading, evidence);
  const uncertainty = element("p", "uncertainty", `Uncertainty: ${view.uncertainty}`);
  elements.investigationResult.replaceChildren(source, summary, hypothesis, uncertainty);
  if (view.action) {
    const action = element("aside", "proposed-action");
    action.append(
      element("span", "", view.action.status),
      element("strong", "", view.action.label),
      element("p", "", view.action.rationale),
      element("small", "", view.action.risk),
    );
    elements.investigationResult.append(action);
  }
  elements.investigationResult.hidden = false;
}

function renderTimeline() {
  const timeline = [...incident.timeline];
  elements.timelineCount.textContent = `${timeline.length} events`;
  elements.timeline.replaceChildren(...timeline.map((entry) => {
    const item = document.createElement("li");
    item.innerHTML = `<time>${new Date(entry.timestamp).toLocaleTimeString()}</time><span class="timeline-type">${entry.type.replaceAll("_", " ")}</span><span>${entry.message}</span>`;
    return item;
  }));
}

function renderLogs(logs) {
  if (logs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No captured incident logs yet.";
    elements.logs.replaceChildren(empty);
    return;
  }
  elements.logs.replaceChildren(...logs.slice().reverse().slice(0, 8).map((entry) => {
    const item = document.createElement("li");
    item.innerHTML = `<time>${new Date(entry.timestamp).toLocaleTimeString()}</time><span class="${entry.level}">${entry.level.toUpperCase()}</span><p>${entry.message}</p>`;
    return item;
  }));
}

function renderMetricChart(target, samples, metric) {
  const values = samples.map((sample) => sample[metric]).filter((value) => typeof value === "number");
  const maximum = Math.max(1, ...values);
  target.replaceChildren(...values.map((value, index) => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(5, (value / maximum) * 100)}%`;
    bar.title = `${format(value)} at sample ${index + 1}`;
    return bar;
  }));
}

function renderMetrics(histories) {
  const cards = selectIncidentMetricCards({ alerts: incident.alerts, topology: evidence.topology, histories });
  elements.metrics.hidden = cards.length === 0;
  const historyByService = new Map(histories.map((history) => [history.serviceId, history]));
  elements.metrics.replaceChildren(...cards.map((card) => renderMetricCard(card, historyByService.get(card.serviceId))));
}

function renderMetricCard(card, history) {
  const current = history?.samples.at(-1)?.[card.metric];
  const article = element("article");
  const heading = element("div");
  heading.append(element("p", "eyebrow", `Incident record / ${card.serviceName}`), element("h2", "", metricLabel(card.metric)));
  const value = element("strong", "", `${format(typeof current === "number" ? current : 0)} ${metricUnit(card.metric)}`);
  const chart = element("div", `metric-chart${card.metric === "errorRate" || card.metric === "queueLag" ? " warning" : ""}`);
  renderMetricChart(chart, history?.samples ?? [], card.metric);
  article.append(heading, value, chart);
  return article;
}

function metricLabel(metric) {
  return ({ latencyMs: "Latency p95", errorRate: "Error rate", trafficRpm: "Request volume", cpuPercent: "CPU utilization", queueLag: "Queue lag" })[metric] ?? metric;
}

function metricUnit(metric) {
  return ({ latencyMs: "ms", errorRate: "%", trafficRpm: "rpm", cpuPercent: "%", queueLag: "messages" })[metric] ?? "";
}

function renderTopology(topology) {
  const graph = buildTopologyGraph(topology);
  const affected = new Set(incident.affectedServices);
  const canvas = document.createElement("div");
  canvas.className = "room-topology-canvas";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("room-topology-lines");
  svg.setAttribute("viewBox", "0 0 1000 480");
  svg.setAttribute("aria-hidden", "true");
  for (const edge of graph.edges) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const startX = edge.fromNode.x * 10 + 78;
    const startY = edge.fromNode.y * 4.8;
    const endX = edge.toNode.x * 10 - 78;
    const endY = edge.toNode.y * 4.8;
    const midpoint = (startX + endX) / 2;
    path.setAttribute("d", `M ${startX} ${startY} C ${midpoint} ${startY}, ${midpoint} ${endY}, ${endX} ${endY}`);
    path.classList.add("room-topology-edge", affected.has(edge.from) && affected.has(edge.to) ? "active" : edge.health);
    svg.append(path);
  }
  canvas.append(svg);
  for (const service of graph.nodes) {
    const node = document.createElement("div");
    node.className = `room-node ${service.health}${affected.has(service.id) ? " affected" : ""}`;
    node.style.left = `${service.x}%`;
    node.style.top = `${service.y}%`;
    node.innerHTML = `<span>${service.kind}</span><strong>${service.name}</strong><small>${format(service.metrics.latencyMs)} ms</small>`;
    canvas.append(node);
  }
  elements.topology.replaceChildren(canvas);
}

function renderLiveState(nextSystem) {
  system = nextSystem;
  const unhealthy = system.services.filter((service) => service.health !== "healthy").length;
  elements.liveState.textContent = unhealthy === 0
    ? `Live system now: healthy · ${system.scenario.replaceAll("-", " ")}`
    : `Live system now: ${unhealthy} component${unhealthy === 1 ? "" : "s"} degraded · ${system.scenario.replaceAll("-", " ")}`;
}

function renderEvidence(nextEvidence) {
  evidence = nextEvidence;
  renderMetrics(evidence.metricHistories);
  renderLogs(evidence.logs);
  renderTopology(evidence.topology);
}

async function refreshEvidence() {
  if (!incidentId) return;
  renderEvidence(await getJson(`/api/incidents/${encodeURIComponent(incidentId)}/evidence`));
}

async function loadRoom() {
  if (!incidentId) {
    showError("An incident ID is required to open an Incident Room.");
    return;
  }
  try {
    const [nextIncident, nextEvidence, nextSystem] = await Promise.all([getJson(`/api/incidents/${encodeURIComponent(incidentId)}`), getJson(`/api/incidents/${encodeURIComponent(incidentId)}/evidence`), getJson("/api/system")]);
    renderIncident(nextIncident);
    renderEvidence(nextEvidence);
    renderLiveState(nextSystem);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to load Incident Room.");
  }
}

const liveEvents = new EventSource("/api/events");
liveEvents.addEventListener("system", async (event) => {
  if (!incident) return;
  renderLiveState(JSON.parse(event.data).system);
  try { await refreshEvidence(); } catch { showError("Incident evidence refresh failed."); }
});

liveEvents.addEventListener("incident-updated", (event) => {
  const update = JSON.parse(event.data);
  if (update.incident?.id === incidentId) {
    renderIncident(update.incident);
    refreshEvidence().catch(() => showError("Incident evidence refresh failed."));
  }
});

elements.investigateButton.addEventListener("click", async () => {
  if (!incident) return;
  elements.investigateButton.disabled = true;
  elements.investigateButton.textContent = "Analyzing evidence…";
  try {
    const response = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/investigate`, { method: "POST" });
    if (!response.ok) throw new Error("Unable to analyze incident evidence");
    renderInvestigation(await response.json());
    renderIncident(await getJson(`/api/incidents/${encodeURIComponent(incident.id)}`));
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to analyze incident evidence.");
  } finally {
    elements.investigateButton.disabled = false;
    elements.investigateButton.textContent = "Analyze again";
  }
});

loadRoom();
