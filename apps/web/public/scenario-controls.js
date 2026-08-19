const controls = {
  "bad-payment-deployment": { method: "POST", path: "/api/simulator/bad-payment-deployment" },
  "redis-degradation": { method: "POST", path: "/api/simulator/redis-degradation" },
  "kafka-backlog": { method: "POST", path: "/api/simulator/kafka-backlog" },
};

export function scenarioControl(name) {
  const control = controls[name];
  if (!control) throw new Error(`Unknown simulator scenario: ${name}`);
  return control;
}

export function serviceOutageRequest(serviceId) {
  if (typeof serviceId !== "string" || serviceId.length === 0) throw new Error("A service outage target is required");
  return { method: "POST", path: "/api/simulator/service-outage", body: { serviceId } };
}
