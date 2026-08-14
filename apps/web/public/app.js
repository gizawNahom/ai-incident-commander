const latency = document.querySelector("#latency-value");
const updatedAt = document.querySelector("#updated-at");
const streamStatus = document.querySelector("#stream-status");
const eventMessage = document.querySelector("#event-message");
const sparkline = document.querySelector("#sparkline");
const samples = [];

function render(sample) {
  samples.push(sample.value);
  if (samples.length > 24) samples.shift();
  latency.textContent = sample.value.toFixed(1);
  updatedAt.textContent = `Updated ${new Date(sample.timestamp).toLocaleTimeString()}`;
  eventMessage.textContent = `${sample.serviceId}: ${sample.metric} = ${sample.value.toFixed(1)}ms`;
  sparkline.replaceChildren(...samples.map((value) => {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(16, Math.min(100, value - 20))}%`;
    return bar;
  }));
}

fetch("/api/telemetry/current").then((response) => response.json()).then(render);
const events = new EventSource("/api/events");
events.addEventListener("open", () => { streamStatus.textContent = "Streaming"; });
events.addEventListener("telemetry", (event) => render(JSON.parse(event.data)));
events.addEventListener("error", () => { streamStatus.textContent = "Reconnecting"; });
