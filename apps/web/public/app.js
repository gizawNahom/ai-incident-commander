import { buildTopologyGraph } from "./topology.js";

const byId = (id) => document.getElementById(id);
const elements = {
  activeIncidents: byId("active-incidents"),
  affected: byId("affected-services"),
  checkoutErrors: byId("checkout-errors"),
  description: byId("scenario-description"),
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
  recover: byId("recover-system"),
  redisLatency: byId("redis-latency"),
  scenario: byId("scenario-badge"),
  serviceGrid: byId("service-grid"),
  stream: byId("stream-status"),
  trigger: byId("trigger-deployment"),
  updated: byId("updated-at"),
};

let system;
let incident;
let selectedServiceId = "payment-service";
const events = [];

function getService(id) {
  return system?.services.find((service) => service.id === id);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function scenarioCopy(name) {
  if (name === "bad-payment-deployment") return "Defective payment-service v1.8.3 is degrading the checkout path.";
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

  renderTopology();
  renderFocus();
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
  elements.incidentSubtitle.textContent = `Created at ${new Date(incident.startedAt).toLocaleTimeString()} after correlated Payment and Checkout alerts.`;
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

function renderFocus() {
  const service = getService(selectedServiceId);
  if (!service) return;
  const dependencies = service.dependencies.length ? service.dependencies.join("  →  ") : "No direct dependencies";
  elements.focus.innerHTML = `<h2>${service.name}</h2><p class="${service.health}">${service.health.toUpperCase()} · ${service.version}</p><div class="focus-metrics"><div><span>Latency</span><strong>${formatNumber(service.metrics.latencyMs)} ms</strong></div><div><span>Error rate</span><strong>${formatNumber(service.metrics.errorRate)}%</strong></div><div><span>Traffic</span><strong>${formatNumber(service.metrics.trafficRpm)} rpm</strong></div><div><span>CPU</span><strong>${formatNumber(service.metrics.cpuPercent)}%</strong></div></div><div class="dependency-list">Dependencies<br>${dependencies}</div>`;
}

function addEvent(event) {
  if (event.type === "telemetry" || event.type === "system") return;
  const normalized = event.type === "alert-triggered"
    ? { type: "alert", timestamp: event.alert.triggeredAt, level: "warn", message: event.alert.title }
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

async function sendControl(path, button) {
  button.disabled = true;
  try {
    const response = await fetch(path, { method: "POST" });
    if (!response.ok) throw new Error("Control request failed");
  } catch (error) {
    addEvent({ type: "log", timestamp: new Date().toISOString(), level: "error", message: error instanceof Error ? error.message : "Control request failed" });
  } finally {
    button.disabled = false;
  }
}

elements.trigger.addEventListener("click", () => sendControl("/api/simulator/bad-payment-deployment", elements.trigger));
elements.recover.addEventListener("click", () => sendControl("/api/simulator/recover", elements.recover));

fetch("/api/system").then((response) => response.json()).then(renderSystem).catch(() => { elements.description.textContent = "Unable to load the simulator snapshot."; });
fetch("/api/incidents").then((response) => response.json()).then((payload) => renderIncident(payload.incidents[0])).catch(() => renderIncident(undefined));
const liveEvents = new EventSource("/api/events");
liveEvents.addEventListener("open", () => { elements.stream.textContent = "Streaming"; });
liveEvents.addEventListener("system", (event) => renderSystem(JSON.parse(event.data).system));
liveEvents.addEventListener("deployment", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("log", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("alert-triggered", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("incident-created", (event) => {
  const change = JSON.parse(event.data);
  addEvent(change);
  renderIncident(change.incident);
});
liveEvents.addEventListener("error", () => { elements.stream.textContent = "Reconnecting"; });
