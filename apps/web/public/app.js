const byId = (id) => document.getElementById(id);
const elements = {
  affected: byId("affected-services"),
  checkoutErrors: byId("checkout-errors"),
  description: byId("scenario-description"),
  eventCount: byId("event-count"),
  eventList: byId("event-list"),
  focus: byId("service-focus"),
  gatewayTraffic: byId("gateway-traffic"),
  health: byId("system-health"),
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

  elements.serviceGrid.replaceChildren(...system.services.map((service) => {
    const node = document.createElement("button");
    node.className = `service ${service.health}${selectedServiceId === service.id ? " selected" : ""}`;
    node.type = "button";
    node.innerHTML = `<small>${service.kind} · ${service.health}</small><strong>${service.name}</strong><span>${formatNumber(service.metrics.latencyMs)} ms p95</span>`;
    node.addEventListener("click", () => { selectedServiceId = service.id; renderSystem(system); });
    return node;
  }));
  renderFocus();
}

function renderFocus() {
  const service = getService(selectedServiceId);
  if (!service) return;
  const dependencies = service.dependencies.length ? service.dependencies.join("  →  ") : "No direct dependencies";
  elements.focus.innerHTML = `<h2>${service.name}</h2><p class="${service.health}">${service.health.toUpperCase()} · ${service.version}</p><div class="focus-metrics"><div><span>Latency</span><strong>${formatNumber(service.metrics.latencyMs)} ms</strong></div><div><span>Error rate</span><strong>${formatNumber(service.metrics.errorRate)}%</strong></div><div><span>Traffic</span><strong>${formatNumber(service.metrics.trafficRpm)} rpm</strong></div><div><span>CPU</span><strong>${formatNumber(service.metrics.cpuPercent)}%</strong></div></div><div class="dependency-list">Dependencies<br>${dependencies}</div>`;
}

function addEvent(event) {
  if (event.type === "telemetry" || event.type === "system") return;
  events.unshift(event);
  if (events.length > 8) events.pop();
  elements.eventCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  elements.eventList.replaceChildren(...events.map((item) => {
    const row = document.createElement("li");
    const level = item.type === "log" ? item.level : "";
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
const liveEvents = new EventSource("/api/events");
liveEvents.addEventListener("open", () => { elements.stream.textContent = "Streaming"; });
liveEvents.addEventListener("system", (event) => renderSystem(JSON.parse(event.data).system));
liveEvents.addEventListener("deployment", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("log", (event) => addEvent(JSON.parse(event.data)));
liveEvents.addEventListener("error", () => { elements.stream.textContent = "Reconnecting"; });
