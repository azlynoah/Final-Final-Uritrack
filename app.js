const PRESSURE_MIN = 5;
const PRESSURE_MAX = 25;
const PRESSURE_NOTICE = 10;
const PRESSURE_GREEN = 15;
const PRESSURE_RED = 25;
const VOLUME_ALERT = 250;

const BLE_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const BLE_CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

const state = {
  connected: false,
  simulating: false,
  simulationTimer: null,
  current: null,
  readings: [],
  history: loadJson("uritrack.history", []),
  patient: loadJson("uritrack.patient", {}),
  alerts: loadJson("uritrack.alerts", []),
};

const els = {
  connectionState: document.getElementById("connectionState"),
  connectBleBtn: document.getElementById("connectBleBtn"),
  simulateBtn: document.getElementById("simulateBtn"),
  alertBanner: document.getElementById("alertBanner"),
  batteryFill: document.getElementById("batteryFill"),
  fillPercent: document.getElementById("fillPercent"),
  pressureValue: document.getElementById("pressureValue"),
  volumeValue: document.getElementById("volumeValue"),
  impedanceValue: document.getElementById("impedanceValue"),
  lastReading: document.getElementById("lastReading"),
  liveChart: document.getElementById("liveChart"),
  reportChart: document.getElementById("reportChart"),
  historyBody: document.getElementById("historyBody"),
  voidingForm: document.getElementById("voidingForm"),
  addVoidingBtn: document.getElementById("addVoidingBtn"),
  actualVolume: document.getElementById("actualVolume"),
  savePatientBtn: document.getElementById("savePatientBtn"),
  exportPdfBtn: document.getElementById("exportPdfBtn"),
  avgPressure: document.getElementById("avgPressure"),
  avgPreVolume: document.getElementById("avgPreVolume"),
  totalRemoved: document.getElementById("totalRemoved"),
  alertCount: document.getElementById("alertCount"),
  patientName: document.getElementById("patientName"),
  patientAge: document.getElementById("patientAge"),
  patientSex: document.getElementById("patientSex"),
  patientCondition: document.getElementById("patientCondition"),
  patientDiagnosis: document.getElementById("patientDiagnosis"),
};

document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

els.connectBleBtn.addEventListener("click", connectBleSensor);
els.simulateBtn.addEventListener("click", toggleSimulation);
els.addVoidingBtn.addEventListener("click", () => els.voidingForm.classList.toggle("active"));
els.voidingForm.addEventListener("submit", recordVoiding);
els.savePatientBtn.addEventListener("click", savePatient);
els.exportPdfBtn.addEventListener("click", exportPdfReport);

hydratePatientForm();
renderAll();
drawCharts();

function setView(viewId) {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === viewId);
  });
  drawCharts();
}

async function connectBleSensor() {
  if (!navigator.bluetooth) {
    setConnection("BLE indisponível neste navegador");
    return;
  }

  try {
    stopSimulation();
    setConnection("A procurar sensor...");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: [BLE_SERVICE_UUID],
    });

    device.addEventListener("gattserverdisconnected", () => {
      state.connected = false;
      setConnection("Desligado");
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", (event) => {
      const reading = parseSensorPayload(event.target.value);
      ingestReading(reading);
    });

    state.connected = true;
    setConnection(`Ligado a ${device.name || "sensor UriTrack"}`);
  } catch (error) {
    setConnection("Falha na ligação BLE");
    console.error(error);
  }
}

function parseSensorPayload(dataView) {
  const bytes = new Uint8Array(dataView.buffer);
  const text = new TextDecoder().decode(bytes).replace(/\0/g, "").trim();

  try {
    const json = JSON.parse(text);
    return normalizeReading({
      pressure: Number(json.pressureCmH2O ?? json.pressure),
      volume: Number(json.volumeMl ?? json.volume),
      impedance: Number(json.impedanceOhm ?? json.impedance),
    });
  } catch {
    if (dataView.byteLength >= 12) {
      return normalizeReading({
        pressure: dataView.getFloat32(0, true),
        volume: dataView.getFloat32(4, true),
        impedance: dataView.getFloat32(8, true),
      });
    }
  }

  throw new Error("Formato de dados BLE não reconhecido");
}

function toggleSimulation() {
  if (state.simulating) {
    stopSimulation();
    setConnection("Desligado");
    return;
  }

  state.simulating = true;
  state.connected = false;
  els.simulateBtn.textContent = "Parar";
  setConnection("Modo simulação");
  let tick = state.readings.length;
  state.simulationTimer = window.setInterval(() => {
    tick += 1;
    const wave = (Math.sin(tick / 9) + 1) / 2;
    const fill = Math.min(1, (tick % 120) / 120 + wave * 0.12);
    const pressure = 5 + fill * 23 + Math.sin(tick / 4) * 0.8;
    const volume = 40 + fill * 285 + Math.sin(tick / 6) * 9;
    const impedance = 735 - fill * 145 + Math.sin(tick / 5) * 12;
    ingestReading(normalizeReading({ pressure, volume, impedance }));
  }, 1000);
}

function stopSimulation() {
  state.simulating = false;
  els.simulateBtn.textContent = "Simular";
  if (state.simulationTimer) window.clearInterval(state.simulationTimer);
  state.simulationTimer = null;
}

function ingestReading(reading) {
  state.current = reading;
  state.readings.push(reading);
  if (state.readings.length > 240) state.readings.shift();
  maybeRegisterAlert(reading);
  renderAll();
  drawCharts();
}

function normalizeReading(reading) {
  const pressure = Number.isFinite(reading.pressure) ? reading.pressure : 0;
  const volume = Number.isFinite(reading.volume) ? reading.volume : estimateVolumeFromPressure(pressure);
  const impedance = Number.isFinite(reading.impedance) ? reading.impedance : 0;
  return {
    at: new Date().toISOString(),
    pressure: round(pressure, 1),
    volume: round(volume, 0),
    impedance: round(impedance, 0),
  };
}

function estimateVolumeFromPressure(pressure) {
  const fill = pressureToFillPercent(pressure) / 100;
  return round(fill * 300, 0);
}

function pressureToFillPercent(pressure) {
  return clamp(((pressure - PRESSURE_MIN) / (PRESSURE_MAX - PRESSURE_MIN)) * 100, 0, 100);
}

function maybeRegisterAlert(reading) {
  const level = getAlertLevel(reading);
  if (level.kind === "neutral") return;
  const last = state.alerts[state.alerts.length - 1];
  const duplicateWindowMs = 60_000;
  if (last && last.kind === level.kind && Date.now() - new Date(last.at).getTime() < duplicateWindowMs) return;
  state.alerts.push({
    at: reading.at,
    kind: level.kind,
    message: level.message,
    pressure: reading.pressure,
    volume: reading.volume,
  });
  saveJson("uritrack.alerts", state.alerts);
}

function getAlertLevel(reading) {
  if (!reading) return { kind: "neutral", message: "A aguardar dados do sensor" };
  if (reading.pressure > PRESSURE_RED) {
    return { kind: "red", message: "Alerta vermelho: bexiga cheia, necessita de esvaziamento" };
  }
  if (reading.pressure > PRESSURE_GREEN) {
    return { kind: "green", message: "Alerta verde: pressão acima de 15 cmH2O" };
  }
  if (reading.pressure > PRESSURE_NOTICE || reading.volume >= VOLUME_ALERT) {
    return { kind: "watch", message: "Atenção: limite de pressão/volume atingido" };
  }
  return { kind: "neutral", message: "Estado dentro dos limites definidos" };
}

function renderAll() {
  renderDashboard();
  renderHistory();
  renderReports();
}

function renderDashboard() {
  const reading = state.current;
  const fill = reading ? pressureToFillPercent(reading.pressure) : 0;
  const alert = getAlertLevel(reading);

  els.batteryFill.style.width = `${fill}%`;
  els.batteryFill.classList.toggle("red", alert.kind === "red");
  els.fillPercent.textContent = `${Math.round(fill)}%`;
  els.pressureValue.textContent = reading ? reading.pressure.toFixed(1) : "--";
  els.volumeValue.textContent = reading ? Math.round(reading.volume) : "--";
  els.impedanceValue.textContent = reading ? Math.round(reading.impedance) : "--";
  els.lastReading.textContent = reading ? formatDateTime(reading.at) : "--";
  els.alertBanner.className = `alert-banner ${alert.kind}`;
  els.alertBanner.textContent = alert.message;
}

function renderHistory() {
  if (!state.history.length) {
    els.historyBody.innerHTML = `<tr><td colspan="4">Sem micções registadas.</td></tr>`;
    return;
  }

  els.historyBody.innerHTML = state.history
    .slice()
    .reverse()
    .map((entry) => `
      <tr>
        <td>${formatDateTime(entry.at)}</td>
        <td>${entry.estimatedVolume} mL</td>
        <td>${entry.actualVolume} mL</td>
        <td>${entry.pressure} cmH2O</td>
      </tr>
    `)
    .join("");
}

function renderReports() {
  const pressureValues = state.readings.map((reading) => reading.pressure);
  const preVolumes = state.history.map((entry) => entry.estimatedVolume);
  const removed = state.history.reduce((sum, entry) => sum + Number(entry.actualVolume || 0), 0);

  els.avgPressure.textContent = pressureValues.length ? `${round(avg(pressureValues), 1)} cmH2O` : "-- cmH2O";
  els.avgPreVolume.textContent = preVolumes.length ? `${round(avg(preVolumes), 0)} mL` : "-- mL";
  els.totalRemoved.textContent = `${round(removed, 0)} mL`;
  els.alertCount.textContent = state.alerts.length;
}

function recordVoiding(event) {
  event.preventDefault();
  const current = state.current || normalizeReading({ pressure: 0, volume: 0, impedance: 0 });
  const actualVolume = Number(els.actualVolume.value || current.volume);
  const entry = {
    at: new Date().toISOString(),
    estimatedVolume: Math.round(current.volume),
    actualVolume: Math.round(actualVolume),
    pressure: current.pressure,
  };
  state.history.push(entry);
  saveJson("uritrack.history", state.history);
  els.actualVolume.value = "";
  els.voidingForm.classList.remove("active");
  renderAll();
  drawCharts();
}

function hydratePatientForm() {
  els.patientName.value = state.patient.name || "";
  els.patientAge.value = state.patient.age || "";
  els.patientSex.value = state.patient.sex || "";
  els.patientCondition.value = state.patient.condition || "";
  els.patientDiagnosis.value = state.patient.diagnosis || "";
}

function savePatient() {
  state.patient = {
    name: els.patientName.value.trim(),
    age: els.patientAge.value,
    sex: els.patientSex.value,
    condition: els.patientCondition.value.trim(),
    diagnosis: els.patientDiagnosis.value.trim(),
  };
  saveJson("uritrack.patient", state.patient);
  els.savePatientBtn.textContent = "Guardado";
  window.setTimeout(() => {
    els.savePatientBtn.textContent = "Guardar";
  }, 1400);
}

function exportPdfReport() {
  const patientName = state.patient.name || "Paciente não identificado";
  const rows = state.history.map((entry) => `
    <tr>
      <td>${formatDateTime(entry.at)}</td>
      <td>${entry.estimatedVolume} mL</td>
      <td>${entry.actualVolume} mL</td>
      <td>${entry.pressure} cmH2O</td>
    </tr>
  `).join("");

  const reportWindow = window.open("", "_blank", "width=920,height=720");
  reportWindow.document.write(`
    <!doctype html>
    <html lang="pt">
      <head>
        <title>Relatório UriTrack</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #0b1f3a; }
          h1 { margin: 0 0 8px; }
          h2 { margin-top: 28px; }
          .meta { color: #5f6f86; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #d8e2ef; padding: 9px; text-align: left; }
          th { background: #eaf2fb; }
          .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 18px 0; }
          .stat { border: 1px solid #d8e2ef; padding: 12px; }
          @page { margin: 18mm; }
        </style>
      </head>
      <body>
        <h1>Relatório UriTrack</h1>
        <p class="meta">Gerado em ${formatDateTime(new Date().toISOString())}</p>
        <h2>Paciente</h2>
        <p><strong>${escapeHtml(patientName)}</strong></p>
        <p>Idade: ${escapeHtml(String(state.patient.age || "--"))} | Sexo: ${escapeHtml(state.patient.sex || "--")}</p>
        <p>Condição clínica: ${escapeHtml(state.patient.condition || "--")}</p>
        <p>Diagnóstico associado: ${escapeHtml(state.patient.diagnosis || "--")}</p>
        <h2>Estatísticas</h2>
        <div class="stats">
          <div class="stat">Pressão média: ${els.avgPressure.textContent}</div>
          <div class="stat">Volume médio pré-esvaziamento: ${els.avgPreVolume.textContent}</div>
          <div class="stat">Total retirado: ${els.totalRemoved.textContent}</div>
          <div class="stat">Eventos de alerta: ${els.alertCount.textContent}</div>
        </div>
        <h2>Histórico de micções</h2>
        <table>
          <thead>
            <tr><th>Data e hora</th><th>Volume estimado</th><th>Volume retirado</th><th>Pressão</th></tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="4">Sem registos.</td></tr>`}</tbody>
        </table>
        <script>window.onload = () => window.print();<\/script>
      </body>
    </html>
  `);
  reportWindow.document.close();
}

function drawCharts() {
  drawLineChart(els.liveChart, state.readings.slice(-60), {
    leftKey: "pressure",
    rightKey: "volume",
    leftLabel: "cmH2O",
    rightLabel: "mL",
  });
  drawLineChart(els.reportChart, state.readings.slice(-120), {
    leftKey: "pressure",
    rightKey: "volume",
    leftLabel: "cmH2O",
    rightLabel: "mL",
  });
}

function drawLineChart(canvas, data, config) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = 42;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, pad);

  if (data.length < 2) {
    ctx.fillStyle = "#5f6f86";
    ctx.font = "16px Segoe UI, Arial";
    ctx.textAlign = "center";
    ctx.fillText("Sem dados suficientes para tendência.", width / 2, height / 2);
    return;
  }

  const leftValues = data.map((row) => row[config.leftKey]);
  const rightValues = data.map((row) => row[config.rightKey]);
  const xFor = (index) => pad + (index / (data.length - 1)) * (width - pad * 2);
  const yFor = (value, min, max) => height - pad - ((value - min) / Math.max(1, max - min)) * (height - pad * 2);

  drawSeries(ctx, data, config.leftKey, xFor, (value) => yFor(value, 0, Math.max(PRESSURE_RED + 5, max(leftValues))), "#0b2f63");
  drawSeries(ctx, data, config.rightKey, xFor, (value) => yFor(value, 0, Math.max(300, max(rightValues))), "#155fa6");

  drawLegend(ctx, width, pad);
}

function drawGrid(ctx, width, height, pad) {
  ctx.strokeStyle = "#d8e2ef";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + ((height - pad * 2) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#aac4e5";
  ctx.strokeRect(pad, pad, width - pad * 2, height - pad * 2);
}

function drawSeries(ctx, data, key, xFor, yFor, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  data.forEach((row, index) => {
    const x = xFor(index);
    const y = yFor(row[key]);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawLegend(ctx, width, pad) {
  ctx.font = "14px Segoe UI, Arial";
  ctx.textAlign = "left";
  ctx.fillStyle = "#0b2f63";
  ctx.fillText("Pressão", pad, 24);
  ctx.fillStyle = "#155fa6";
  ctx.fillText("Volume", width - pad - 92, 24);
}

function setConnection(text) {
  els.connectionState.textContent = text;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values) {
  return values.reduce((highest, value) => Math.max(highest, value), Number.NEGATIVE_INFINITY);
}

function clamp(value, min, maxValue) {
  return Math.min(maxValue, Math.max(min, value));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}
