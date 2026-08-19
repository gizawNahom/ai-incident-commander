const dependencyMetric = (service) => service?.kind === "stream" ? "queueLag" : "latencyMs";

export function selectIncidentMetricCards({ alerts, topology, histories }) {
  const services = new Map(topology.map((service) => [service.id, service]));
  const historyByService = new Map(histories.map((history) => [history.serviceId, history]));
  const cards = [];
  const selectedServiceIds = new Set();

  const add = (serviceId, metric) => {
    if (cards.length === 3 || selectedServiceIds.has(serviceId)) return;
    const service = services.get(serviceId);
    const history = historyByService.get(serviceId);
    if (!service || !history || !history.samples.some((sample) => typeof sample[metric] === "number")) return;
    selectedServiceIds.add(serviceId);
    cards.push({ serviceId, serviceName: service.name, metric });
  };

  for (const alert of alerts) add(alert.serviceId, alert.metric);
  for (const alert of alerts) {
    const service = services.get(alert.serviceId);
    for (const dependencyId of service?.dependencies ?? []) add(dependencyId, dependencyMetric(services.get(dependencyId)));
  }
  return cards;
}
