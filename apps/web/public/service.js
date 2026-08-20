const byId = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const serviceId = params.get("id");
const elements = {
  alerts: byId("service-alerts"),
  dependencies: byId("dependencies"),
  dependents: byId("dependents"),
  deployments: byId("service-deployments"),
  error: byId("service-error"),
  history: byId("service-history"),
  logs: byId("service-logs"),
  metrics: byId("service-metrics"),
  name: byId("service-name"),
  relatedIncidents: byId("related-incidents"),
  summary: byId("service-summary"),
  updated: byId("service-updated"),
};

function format(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function emptyList(message) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = message;
  return item;
}

function linkList(target, services, emptyMessage) {
  if (services.length === 0) {
    target.replaceChildren(emptyList(emptyMessage));
    return;
  }
  target.replaceChildren(...services.map((service) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/service.html?id=${encodeURIComponent(service.id)}`;
    link.textContent = service.name;
    item.append(link);
    return item;
  }));
}

function renderMetrics(service) {
  const definitions = [
    ["Latency", `${format(service.metrics.latencyMs)} ms`],
    ["Error rate", `${format(service.metrics.errorRate)}%`],
    ["Traffic", `${format(service.metrics.trafficRpm)} rpm`],
    ["CPU", `${format(service.metrics.cpuPercent)}%`],
  ];
  if (service.kind === "stream" || service.metrics.queueLag > 0) definitions.push(["Queue lag", `${format(service.metrics.queueLag)} messages`]);
  elements.metrics.replaceChildren(...definitions.map(([label, value]) => {
    const article = document.createElement("article");
    const heading = document.createElement("span");
    heading.textContent = label;
    const metric = document.createElement("strong");
    metric.textContent = value;
    article.append(heading, metric);
    return article;
  }));
}

function renderHistory(samples) {
  const visible = samples.slice(-60);
  const maximum = Math.max(...visible.map((sample) => sample.latencyMs), 1);
  elements.history.replaceChildren(...visible.map((sample) => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(4, Math.round((sample.latencyMs / maximum) * 100))}%`;
    bar.title = `${new Date(sample.timestamp).toLocaleTimeString()} · ${format(sample.latencyMs)} ms`;
    return bar;
  }));
}

function renderLogs(logs) {
  if (logs.length === 0) {
    elements.logs.replaceChildren(emptyList("No recent log entries for this service."));
    return;
  }
  elements.logs.replaceChildren(...logs.slice(-12).reverse().map((log) => {
    const item = document.createElement("li");
    item.innerHTML = `<time>${new Date(log.timestamp).toLocaleTimeString()}</time><span class="${log.level}">${log.level}</span><p>${log.message}</p>`;
    return item;
  }));
}

function renderDeployments(service, deployments) {
  const current = document.createElement("p");
  current.className = "current-version";
  current.textContent = `Running ${service.version}`;
  const history = deployments.length === 0 ? document.createElement("p") : document.createElement("ul");
  if (deployments.length === 0) history.textContent = "No deployment events recorded in this process.";
  else {
    for (const deployment of deployments.slice(-4).reverse()) {
      const item = document.createElement("li");
      item.textContent = `${new Date(deployment.timestamp).toLocaleTimeString()} · ${deployment.message}`;
      history.append(item);
    }
  }
  elements.deployments.replaceChildren(current, history);
}

function renderAlerts(alerts) {
  if (alerts.length === 0) {
    elements.alerts.replaceChildren(emptyList("No active alert conditions."));
    return;
  }
  elements.alerts.replaceChildren(...alerts.map((alert) => {
    const item = document.createElement("li");
    item.textContent = `${alert.severity} · ${alert.title} · ${format(alert.observedValue)}${alert.unit} observed`;
    return item;
  }));
}

function renderIncidents(incidents) {
  if (incidents.length === 0) {
    elements.relatedIncidents.replaceChildren(emptyList("No incident records are related to this service."));
    return;
  }
  elements.relatedIncidents.replaceChildren(...incidents.map((incident) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/incident.html?id=${encodeURIComponent(incident.id)}`;
    link.textContent = `${incident.id} · ${incident.title}`;
    const state = document.createElement("small");
    state.textContent = `${incident.severity} · ${incident.status}`;
    item.append(link, state);
    return item;
  }));
}

function render(detail) {
  const { service } = detail;
  elements.error.hidden = true;
  elements.name.textContent = service.name;
  elements.summary.textContent = `${service.kind} · ${service.version} · ${service.health.toUpperCase()} now`;
  elements.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  renderMetrics(service);
  renderHistory(detail.history.samples);
  linkList(elements.dependencies, detail.dependencies, "No direct dependencies.");
  linkList(elements.dependents, detail.dependents, "No monitored dependents.");
  renderLogs(detail.logs);
  renderDeployments(service, detail.deployments);
  renderAlerts(detail.activeAlerts);
  renderIncidents(detail.relatedIncidents);
}

async function load() {
  if (!serviceId) {
    elements.error.textContent = "Choose a service from the Services inventory.";
    elements.error.hidden = false;
    return;
  }
  try {
    const response = await fetch(`/api/services/${encodeURIComponent(serviceId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Unable to load service detail");
    render(payload);
  } catch (error) {
    elements.error.textContent = error instanceof Error ? error.message : "Unable to load service detail.";
    elements.error.hidden = false;
  }
}

const stream = new EventSource("/api/events");
stream.addEventListener("system", load);
stream.addEventListener("incident-created", load);
stream.addEventListener("incident-updated", load);
stream.addEventListener("alert-triggered", load);
load();
