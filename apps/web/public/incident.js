import { buildTopologyGraph } from "./topology.js";

const incidentId = new URLSearchParams(window.location.search).get("id");
const elements = {
  alerts: document.getElementById("room-alerts"),
  checkoutChart: document.getElementById("checkout-chart"),
  checkoutCurrent: document.getElementById("checkout-current"),
  error: document.getElementById("room-error"),
  header: document.getElementById("room-header"),
  logs: document.getElementById("room-logs"),
  metrics: document.getElementById("room-metrics"),
  paymentChart: document.getElementById("payment-chart"),
  paymentCurrent: document.getElementById("payment-current"),
  redisChart: document.getElementById("redis-chart"),
  redisCurrent: document.getElementById("redis-current"),
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
};

let incident;
let system;
const logs = [];

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
  elements.header.innerHTML = `<p class="eyebrow">Incident room / live investigation</p><h1>${incident.id} — ${incident.title}</h1><p>Created from correlated service alerts. Evidence remains connected to the live simulator.</p>`;
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

function renderLogs() {
  elements.logs.replaceChildren(...logs.slice(0, 8).map((entry) => {
    const item = document.createElement("li");
    item.innerHTML = `<time>${new Date(entry.timestamp).toLocaleTimeString()}</time><span class="${entry.level}">${entry.level.toUpperCase()}</span><p>${entry.message}</p>`;
    return item;
  }));
}

function renderMetricChart(target, samples, metric) {
  const values = samples.map((sample) => sample[metric]);
  const maximum = Math.max(1, ...values);
  target.replaceChildren(...values.map((value, index) => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(5, (value / maximum) * 100)}%`;
    bar.title = `${format(value)} at sample ${index + 1}`;
    return bar;
  }));
}

function renderMetrics(histories) {
  const [payment, checkout, redis] = histories;
  const currentPayment = payment.samples.at(-1);
  const currentCheckout = checkout.samples.at(-1);
  const currentRedis = redis.samples.at(-1);
  elements.paymentCurrent.textContent = `${format(currentPayment.latencyMs)} ms`;
  elements.checkoutCurrent.textContent = `${format(currentCheckout.errorRate)}%`;
  elements.redisCurrent.textContent = `${format(currentRedis.latencyMs)} ms`;
  renderMetricChart(elements.paymentChart, payment.samples, "latencyMs");
  renderMetricChart(elements.checkoutChart, checkout.samples, "errorRate");
  renderMetricChart(elements.redisChart, redis.samples, "latencyMs");
}

function renderTopology() {
  const graph = buildTopologyGraph(system.services);
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

async function refreshMetrics() {
  const histories = await Promise.all(["payment-service", "checkout-service", "redis"].map((service) => getJson(`/api/telemetry/history?service=${service}`)));
  renderMetrics(histories);
}

async function loadRoom() {
  if (!incidentId) {
    showError("An incident ID is required to open an Incident Room.");
    return;
  }
  try {
    const [nextIncident, nextSystem] = await Promise.all([getJson(`/api/incidents/${encodeURIComponent(incidentId)}`), getJson("/api/system")]);
    renderIncident(nextIncident);
    system = nextSystem;
    renderTopology();
    await refreshMetrics();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to load Incident Room.");
  }
}

const liveEvents = new EventSource("/api/events");
liveEvents.addEventListener("system", async (event) => {
  if (!incident) return;
  system = JSON.parse(event.data).system;
  renderTopology();
  try { await refreshMetrics(); } catch { showError("Live metric refresh failed."); }
});
liveEvents.addEventListener("log", (event) => {
  if (!incident) return;
  const entry = JSON.parse(event.data);
  if (!incident.affectedServices.includes(entry.serviceId)) return;
  logs.unshift(entry);
  renderLogs();
});

loadRoom();
