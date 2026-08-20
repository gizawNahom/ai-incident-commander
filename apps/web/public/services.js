const byId = (id) => document.getElementById(id);
const list = byId("service-list");
const count = byId("service-count");
const updated = byId("services-updated");

function format(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function metricCell(value, unit) {
  const cell = document.createElement("td");
  cell.textContent = `${format(value)} ${unit}`;
  return cell;
}

function render(services) {
  count.textContent = `${services.length} monitored components`;
  updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  list.replaceChildren(...services.map((service) => {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = service.name;
    const kind = document.createElement("small");
    kind.textContent = `${service.kind} · ${service.version}`;
    identity.append(name, kind);
    const health = document.createElement("td");
    health.innerHTML = `<span class="health-label ${service.health}"><i></i>${service.health}</span>`;
    const alerts = document.createElement("td");
    alerts.textContent = String(service.activeAlertCount);
    const incidents = document.createElement("td");
    incidents.textContent = String(service.relatedIncidentCount);
    const detail = document.createElement("td");
    const link = document.createElement("a");
    link.className = "table-link";
    link.href = `/service.html?id=${encodeURIComponent(service.id)}`;
    link.textContent = "Inspect →";
    detail.append(link);
    row.append(identity, health, metricCell(service.metrics.latencyMs, "ms"), metricCell(service.metrics.errorRate, "%"), metricCell(service.metrics.trafficRpm, "rpm"), alerts, incidents, detail);
    return row;
  }));
}

async function load() {
  try {
    const response = await fetch("/api/services");
    if (!response.ok) throw new Error("Unable to load service inventory");
    const payload = await response.json();
    render(payload.services);
  } catch (error) {
    list.innerHTML = `<tr><td colspan="8" class="empty">${error instanceof Error ? error.message : "Unable to load services."}</td></tr>`;
  }
}

const stream = new EventSource("/api/events");
stream.addEventListener("system", load);
stream.addEventListener("incident-created", load);
stream.addEventListener("incident-updated", load);
stream.addEventListener("alert-triggered", load);
load();
