const byId = (id) => document.getElementById(id);
const elements = {
  count: byId("incident-count"),
  empty: byId("empty-incident-history"),
  list: byId("incident-history-list"),
  severity: byId("severity-filter"),
  status: byId("status-filter"),
  updated: byId("incidents-updated"),
};

function localTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "—";
}

function render(incidents) {
  elements.count.textContent = `${incidents.length} incident record${incidents.length === 1 ? "" : "s"}`;
  elements.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  elements.empty.hidden = incidents.length !== 0;
  if (incidents.length === 0) {
    elements.list.innerHTML = '<tr><td colspan="7" class="empty">No incident records match these filters.</td></tr>';
    return;
  }
  elements.list.replaceChildren(...incidents.map((incident) => {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const id = document.createElement("strong");
    id.textContent = incident.id;
    const title = document.createElement("small");
    title.textContent = incident.title;
    identity.append(id, title);
    const severity = document.createElement("td");
    severity.innerHTML = `<span class="severity-tag ${incident.severity.toLowerCase()}">${incident.severity}</span>`;
    const status = document.createElement("td");
    status.innerHTML = `<span class="status-tag ${incident.status.toLowerCase()}">${incident.status}</span>`;
    const services = document.createElement("td");
    services.textContent = incident.affectedServices.join(", ");
    const started = document.createElement("td");
    started.textContent = localTime(incident.startedAt);
    const resolved = document.createElement("td");
    resolved.textContent = localTime(incident.resolvedAt);
    const open = document.createElement("td");
    const link = document.createElement("a");
    link.className = "table-link";
    link.href = `/incident.html?id=${encodeURIComponent(incident.id)}`;
    link.textContent = "Open room →";
    open.append(link);
    row.append(identity, severity, status, services, started, resolved, open);
    return row;
  }));
}

async function load() {
  const query = new URLSearchParams();
  if (elements.status.value) query.set("status", elements.status.value);
  if (elements.severity.value) query.set("severity", elements.severity.value);
  try {
    const response = await fetch(`/api/incidents${query.size ? `?${query}` : ""}`);
    if (!response.ok) throw new Error("Unable to load incident history");
    render((await response.json()).incidents);
  } catch (error) {
    elements.list.innerHTML = `<tr><td colspan="7" class="empty">${error instanceof Error ? error.message : "Unable to load incidents."}</td></tr>`;
  }
}

elements.status.addEventListener("change", load);
elements.severity.addEventListener("change", load);
const stream = new EventSource("/api/events");
stream.addEventListener("incident-created", load);
stream.addEventListener("incident-updated", load);
load();
