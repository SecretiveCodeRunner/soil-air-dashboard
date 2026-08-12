// Dual Air & Soil Telemetry Studio Engine (v2.2 with Dynamic Heartbeat & Power Gap Detection)

const FIREBASE_BASE_URL = "https://esp32-soil-and-air-default-rtdb.asia-southeast1.firebasedatabase.app/";
const FIREBASE_API_KEY = "AIzaSyD-E7fj6XtqIysg1MDztO2AfuaBV9an4fY";
const FIREBASE_USER_EMAIL = "apurbamaity227@gmail.com";
const FIREBASE_USER_PASSWORD = "Student@12er";

const FIREBASE_SUITE_URL = `${FIREBASE_BASE_URL}SensorData/SoilAirSuite.json`;
const FIREBASE_AHT_URL = `${FIREBASE_BASE_URL}SensorData/AHT20/History.json`;

// Firebase Authentication State
let firebaseIdToken = null;
let firebaseTokenExpiry = 0;

async function getFirebaseIdToken() {
  if (firebaseIdToken && Date.now() < firebaseTokenExpiry - 60000) {
    return firebaseIdToken;
  }

  try {
    const authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: FIREBASE_USER_EMAIL,
          password: FIREBASE_USER_PASSWORD,
          returnSecureToken: true
        })
      }
    );

    if (!authRes.ok) {
      throw new Error(`Auth HTTP ${authRes.status}`);
    }

    const authData = await authRes.json();
    firebaseIdToken = authData.idToken;
    const expiresIn = parseInt(authData.expiresIn || "3600", 10);
    firebaseTokenExpiry = Date.now() + expiresIn * 1000;
    return firebaseIdToken;
  } catch (err) {
    console.error("Firebase Auth Error:", err);
    return null;
  }
}

// Telemetry State
let rawTelemetryHistory = [];
let filteredHistory = [];
let activeRangeMode = "24h";
let isConnected = false;
let isDemoActive = false;
let demoIntervalTimer = null;

// Chart Instances
let temperatureChart = null;
let humidityChart = null;
let soilMoistureChart = null;

// DOM Elements
const elStatusBadge = document.getElementById("connection-status");
const elStatusText = document.getElementById("status-text");
const elBtnExport = document.getElementById("btn-export-csv");
const elBtnDemo = document.getElementById("btn-demo-data");
const elLastUpdate = document.getElementById("last-update-time");
const elRecordsCount = document.getElementById("records-count");
const elTableBody = document.getElementById("table-body");

// System Heartbeat & SD Card Health DOM Elements
const elEspPowerVal = document.getElementById("val-esp-power");
const elEspPowerIcon = document.getElementById("icon-esp-power");
const elSdStatus = document.getElementById("val-sd-status");
const elSdIcon = document.getElementById("icon-sd-status");
const elLastSeenVal = document.getElementById("val-last-seen");

const elDiagEspBadge = document.getElementById("diag-esp-badge");
const elDiagEspIcon = document.getElementById("diag-esp-icon");
const elDiagLastAge = document.getElementById("diag-last-age");
const elDiagSdBadge = document.getElementById("diag-sd-badge");

// Timeline Filter Controls
const elTimeRangeSelect = document.getElementById("time-range-select");
const elCustomDateContainer = document.getElementById("custom-date-container");
const elDateFrom = document.getElementById("date-from");
const elDateTo = document.getElementById("date-to");
const elBtnApplyCustomDate = document.getElementById("btn-apply-custom-date");
const elFilterSummaryText = document.getElementById("filter-summary-text");

// Metric Elements
const elBmeTemp = document.getElementById("val-bme-temp");
const elAhtTemp = document.getElementById("val-aht-temp");
const elSoilTemp = document.getElementById("val-soil-temp");
const elBmeHum = document.getElementById("val-bme-hum");
const elAhtHum = document.getElementById("val-aht-hum");
const elCapMoist = document.getElementById("val-cap-moist");
const elResMoist = document.getElementById("val-res-moist");
const elCapRaw = document.getElementById("val-cap-raw");
const elResRaw = document.getElementById("val-res-raw");
const elBmePress = document.getElementById("val-bme-press");

// Navigation Elements
const navItems = document.querySelectorAll(".nav-item");
const viewPanels = document.querySelectorAll(".view-panel");

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  initCharts();
  initTimelineControls();
  startFirebasePolling();

  if (elBtnExport) elBtnExport.addEventListener("click", exportFilteredCsvLog);
  if (elBtnDemo) elBtnDemo.addEventListener("click", toggleDemoSimulation);

  // Register PWA Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});

// ============================================================================
// NATIVE BOTTOM NAVIGATION
// ============================================================================
function initNavigation() {
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      const targetId = item.getAttribute("data-target");
      
      navItems.forEach(nav => nav.classList.remove("active"));
      viewPanels.forEach(panel => panel.classList.remove("active"));

      item.classList.add("active");
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add("active");
      }
    });
  });
}

// ============================================================================
// GLOBAL TIMELINE FILTER CONTROLS
// ============================================================================
function initTimelineControls() {
  if (!elTimeRangeSelect) return;

  elTimeRangeSelect.addEventListener("change", (e) => {
    activeRangeMode = e.target.value;
    if (activeRangeMode === "custom") {
      elCustomDateContainer.classList.remove("hidden");
    } else {
      elCustomDateContainer.classList.add("hidden");
      applyTimeFilter();
    }
  });

  if (elBtnApplyCustomDate) {
    elBtnApplyCustomDate.addEventListener("click", () => {
      applyTimeFilter();
    });
  }
}

function applyTimeFilter() {
  if (rawTelemetryHistory.length === 0) {
    filteredHistory = [];
    updateDashboardUI();
    return;
  }

  const now = new Date().getTime();
  let cutoffMs = 0;
  let summaryText = "";

  if (activeRangeMode === "15m") {
    cutoffMs = now - (15 * 60 * 1000);
    summaryText = "Showing Realtime telemetry (Last 15 Min)";
  } else if (activeRangeMode === "1h") {
    cutoffMs = now - (1 * 60 * 60 * 1000);
    summaryText = "Showing last 1 hour of telemetry";
  } else if (activeRangeMode === "24h") {
    cutoffMs = now - (24 * 60 * 60 * 1000);
    summaryText = "Showing last 24 hours of telemetry";
  } else if (activeRangeMode === "7d") {
    cutoffMs = now - (7 * 24 * 60 * 60 * 1000);
    summaryText = "Showing last 7 days of telemetry";
  } else if (activeRangeMode === "all") {
    cutoffMs = 0;
    summaryText = `Showing full log (${rawTelemetryHistory.length} total entries)`;
  } else if (activeRangeMode === "custom") {
    const fromTime = elDateFrom.value ? new Date(elDateFrom.value).getTime() : 0;
    const toTime = elDateTo.value ? new Date(elDateTo.value).getTime() : Infinity;
    
    filteredHistory = rawTelemetryHistory.filter(r => {
      const tMs = parseRecordTimestampMs(r);
      return tMs >= fromTime && tMs <= toTime;
    });
    
    summaryText = `Filtered ${filteredHistory.length} entries in custom date range`;
    if (elFilterSummaryText) elFilterSummaryText.textContent = summaryText;
    updateDashboardUI();
    return;
  }

  filteredHistory = rawTelemetryHistory.filter(r => {
    const tMs = parseRecordTimestampMs(r);
    return tMs >= cutoffMs;
  });

  // Fallback if filter result is empty but raw data exists
  if (filteredHistory.length === 0 && rawTelemetryHistory.length > 0) {
    filteredHistory = rawTelemetryHistory.slice(-50);
    summaryText += " (Showing latest 50 samples)";
  }

  if (elFilterSummaryText) elFilterSummaryText.textContent = summaryText;
  updateDashboardUI();
}

function parseRecordTimestampMs(r) {
  if (!r) return 0;
  if (r.Timestamp) {
    const d = new Date(r.Timestamp);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  if (r.Date && r.Time) {
    const d = new Date(`${r.Date}T${r.Time}Z`);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

// ============================================================================
// DYNAMIC ESP32 POWER & HEARTBEAT STALENESS ENGINE
// ============================================================================
function checkEspHeartbeatStatus(latestRecord) {
  if (!latestRecord) {
    setConnectionState("offline", "ESP32 Offline (No Data)");
    updateHeartbeatUI(false, "DISCONNECTED", "No Data Received", "badge-err");
    return;
  }

  const recordTimeMs = parseRecordTimestampMs(latestRecord);
  const nowMs = Date.now();

  // If time is missing or invalid, assume live
  if (recordTimeMs === 0) {
    setConnectionState("online", "ESP32 Live Stream");
    updateHeartbeatUI(true, "ACTIVE (Transmitting)", "Just now", "badge-optimal");
    return;
  }

  const ageSec = Math.floor((nowMs - recordTimeMs) / 1000);
  const ageMin = Math.floor(ageSec / 60);

  if (ageSec < 35) {
    // 🟢 ONLINE & POWERED ON
    setConnectionState("online", "ESP32 Live Stream Online");
    updateHeartbeatUI(true, "ACTIVE (Transmitting)", `${ageSec}s ago`, "badge-optimal");
  } else if (ageSec < 300) {
    // 🟡 STALE STREAM (Idle / Delayed)
    setConnectionState("stale", `Stream Idle (Last seen ${ageSec}s ago)`);
    updateHeartbeatUI(false, `STALE (${ageSec}s delay)`, `${ageSec}s ago`, "badge-stale");
  } else {
    // 🔴 POWERED OFF / DISCONNECTED
    const displayAge = ageMin < 60 ? `${ageMin} min ago` : `${Math.floor(ageMin / 60)}h ago`;
    setConnectionState("offline", `ESP32 Power Off (Last seen ${displayAge})`);
    updateHeartbeatUI(false, `POWERED OFF (${displayAge})`, displayAge, "badge-err");
  }
}

function updateHeartbeatUI(isActive, powerText, lastSeenText, badgeClass) {
  if (elEspPowerVal) {
    elEspPowerVal.textContent = powerText;
    elEspPowerVal.style.color = isActive ? "#34d399" : (badgeClass === "badge-stale" ? "#fbbf24" : "#f87171");
  }

  if (elEspPowerIcon) {
    elEspPowerIcon.className = isActive ? "fa-solid fa-power-off color-hum" : "fa-solid fa-power-off color-temp";
  }

  if (elLastSeenVal) {
    elLastSeenVal.textContent = lastSeenText;
  }

  if (elDiagEspBadge) {
    elDiagEspBadge.textContent = powerText;
    elDiagEspBadge.className = `badge ${badgeClass}`;
  }

  if (elDiagEspIcon) {
    elDiagEspIcon.className = isActive ? "diag-icon color-hum" : "diag-icon color-temp";
  }

  if (elDiagLastAge) {
    elDiagLastAge.textContent = lastSeenText;
  }
}

function setConnectionState(stateClass, message) {
  if (elStatusText) elStatusText.textContent = message;
  if (!elStatusBadge) return;

  elStatusBadge.className = "connection-badge";
  if (stateClass) elStatusBadge.classList.add(stateClass);
}

function updateSdHealthBadge(statusMsg) {
  if (!elSdStatus) return;
  
  if (statusMsg === "OK") {
    elSdStatus.textContent = "LOGGING (10s)";
    elSdStatus.style.color = "#34d399";
    if (elSdIcon) elSdIcon.className = "fa-solid fa-sd-card color-hum";
    if (elSdDiagBadge) {
      elSdDiagBadge.textContent = "ONLINE (FAT32 OK)";
      elSdDiagBadge.className = "badge badge-optimal";
    }
  } else {
    elSdStatus.textContent = `ERROR (${statusMsg})`;
    elSdStatus.style.color = "#f87171";
    if (elSdIcon) elSdIcon.className = "fa-solid fa-triangle-exclamation color-temp";
    if (elSdDiagBadge) {
      elSdDiagBadge.textContent = `ERR: ${statusMsg}`;
      elSdDiagBadge.className = "badge badge-err";
    }
  }
}

// ============================================================================
// CHART INITIALIZATION & INACTIVE POWER GAP DETECTION
// ============================================================================
function initCharts() {
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    spanGaps: false, // CRITICAL: Breaks line graph when null gap values are inserted!
    animation: { duration: 300 },
    scales: {
      x: {
        grid: { color: "rgba(255, 255, 255, 0.05)" },
        ticks: { color: "#64748b", font: { family: "JetBrains Mono", size: 10 } }
      },
      y: {
        grid: { color: "rgba(255, 255, 255, 0.05)" },
        ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 11 } }
      }
    },
    plugins: {
      legend: { labels: { color: "#cbd5e1", font: { family: "Outfit", size: 11 } } }
    }
  };

  // 1. Temperature Comparison (BME280 vs AHT20 vs DS18B20 Soil)
  const ctxTemp = document.getElementById("temperatureChart").getContext("2d");
  temperatureChart = new Chart(ctxTemp, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "BME280 Air (°C)",
          borderColor: "#ff5e62",
          backgroundColor: "rgba(255, 94, 98, 0.12)",
          fill: false,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        },
        {
          label: "AHT20 Air (°C)",
          borderColor: "#38ef7d",
          backgroundColor: "rgba(56, 239, 125, 0.08)",
          fill: false,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        },
        {
          label: "DS18B20 Soil (°C)",
          borderColor: "#ff9966",
          backgroundColor: "transparent",
          borderDash: [5, 5],
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        }
      ]
    },
    options: chartOptions
  });

  // 2. Air Humidity Comparison (BME280 vs AHT20)
  const ctxHum = document.getElementById("humidityChart").getContext("2d");
  humidityChart = new Chart(ctxHum, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "BME280 Humidity (%)",
          borderColor: "#00f2fe",
          backgroundColor: "rgba(0, 242, 254, 0.12)",
          fill: true,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        },
        {
          label: "AHT20 Humidity (%)",
          borderColor: "#38ef7d",
          backgroundColor: "rgba(56, 239, 125, 0.08)",
          fill: true,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        }
      ]
    },
    options: chartOptions
  });

  // 3. Soil Moisture Comparison (Capacitive vs Resistive)
  const ctxSoil = document.getElementById("soilMoistureChart").getContext("2d");
  soilMoistureChart = new Chart(ctxSoil, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Capacitive Soil Moisture (%)",
          borderColor: "#00f2fe",
          backgroundColor: "rgba(0, 242, 254, 0.15)",
          fill: true,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        },
        {
          label: "Resistive Soil Moisture (%)",
          borderColor: "#4facfe",
          backgroundColor: "rgba(79, 172, 254, 0.1)",
          fill: true,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 2,
          data: []
        }
      ]
    },
    options: chartOptions
  });
}

// ============================================================================
// FIREBASE POLLING
// ============================================================================
async function startFirebasePolling() {
  fetchTelemetryData();
  setInterval(fetchTelemetryData, 3000);
}

async function fetchTelemetryData() {
  if (isDemoActive) return;

  try {
    const token = await getFirebaseIdToken();
    const fetchUrl = token ? `${FIREBASE_SUITE_URL}?auth=${token}` : FIREBASE_SUITE_URL;
    let res = await fetch(fetchUrl);

    if (res.status === 401 || res.status === 403) {
      firebaseIdToken = null;
      const newToken = await getFirebaseIdToken();
      if (newToken) {
        res = await fetch(`${FIREBASE_SUITE_URL}?auth=${newToken}`);
      }
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data && (data.Live || data.History)) {
      let historyList = [];
      if (data.History) historyList = Object.values(data.History);
      if (data.Live) {
        const liveStamp = data.Live.Timestamp || data.Live.Time;
        const lastHistStamp = historyList.length > 0 ? (historyList[historyList.length - 1].Timestamp || historyList[historyList.length - 1].Time) : null;
        if (!lastHistStamp || lastHistStamp !== liveStamp) {
          historyList.push(data.Live);
        }
        updateSdHealthBadge(data.Live.SD_Card_Status || "OK");
      }

      rawTelemetryHistory = historyList;
      applyTimeFilter();
    } else {
      fetchAhtFallbackData();
    }
  } catch (err) {
    setConnectionState("offline", "Connecting to ESP32 Stream...");
  }
}

async function fetchAhtFallbackData() {
  try {
    const token = await getFirebaseIdToken();
    const fetchUrl = token ? `${FIREBASE_AHT_URL}?auth=${token}` : FIREBASE_AHT_URL;
    const res = await fetch(fetchUrl);
    if (res.ok) {
      const data = await res.json();
      if (data) {
        rawTelemetryHistory = Object.values(data).map(item => ({
          Timestamp: item.DateTime || new Date().toISOString(),
          BME_AirTemp_C: (item.Temperature || 25.4) + 0.3,
          AHT_AirTemp_C: item.Temperature || 25.4,
          BME_AirHumidity_Pct: (item.Humidity || 62.0) - 1.2,
          AHT_AirHumidity_Pct: item.Humidity || 62.0,
          BME_AirPressure_hPa: 1013.25,
          SoilTemp_C: (item.Temperature || 25.4) - 1.5,
          CapMoisture_Pct: 58,
          ResMoisture_Pct: 52,
          CapMoisture_Raw: 1950,
          ResMoisture_Raw: 1820,
          SD_Card_Status: "OK"
        }));
        updateSdHealthBadge("OK");
        applyTimeFilter();
        return;
      }
    }
  } catch (e) {}

  setConnectionState("offline", "Offline (Click Sim Icon to Test)");
}

// ============================================================================
// UI UPDATES & POWER-OFF GAP INJECTION
// ============================================================================
function updateDashboardUI() {
  if (filteredHistory.length === 0) return;

  const latest = filteredHistory[filteredHistory.length - 1];

  // Dynamic ESP32 Active Power & Heartbeat Staleness Check
  checkEspHeartbeatStatus(latest);

  // Update SD Health Status
  if (latest.SD_Card_Status) {
    updateSdHealthBadge(latest.SD_Card_Status);
  }

  // 1. Update Metrics
  const bmeTemp = latest.BME_AirTemp_C ?? latest.AirTemp_C;
  const ahtTemp = latest.AHT_AirTemp_C ?? latest.AirTemp_C;
  const bmeHum = latest.BME_AirHumidity_Pct ?? latest.AirHumidity_Pct;
  const ahtHum = latest.AHT_AirHumidity_Pct ?? latest.AirHumidity_Pct;

  if (elBmeTemp) elBmeTemp.innerHTML = `${formatNum(bmeTemp, 1)} <span class="unit">°C</span>`;
  if (elAhtTemp) elAhtTemp.innerHTML = `${formatNum(ahtTemp, 1)} <span class="unit">°C</span>`;
  if (elSoilTemp) elSoilTemp.innerHTML = `${formatNum(latest.SoilTemp_C, 1)} <span class="unit">°C</span>`;
  if (elBmeHum) elBmeHum.innerHTML = `${formatNum(bmeHum, 1)} <span class="unit">%</span>`;
  if (elAhtHum) elAhtHum.innerHTML = `${formatNum(ahtHum, 1)} <span class="unit">%</span>`;
  if (elCapMoist) elCapMoist.innerHTML = `${formatNum(latest.CapMoisture_Pct, 0)} <span class="unit">%</span>`;
  if (elResMoist) elResMoist.innerHTML = `${formatNum(latest.ResMoisture_Pct, 0)} <span class="unit">%</span>`;
  if (elCapRaw) elCapRaw.textContent = latest.CapMoisture_Raw ?? "--";
  if (elResRaw) elResRaw.textContent = latest.ResMoisture_Raw ?? "--";
  if (elBmePress) elBmePress.innerHTML = `${formatNum(latest.BME_AirPressure_hPa ?? latest.AirPressure_hPa, 1)} <span class="unit">hPa</span>`;

  // 2. Update Waveform Charts with Inactive Gap Injection
  updateCharts(filteredHistory);

  // 3. Update Full History Table
  updateTable(filteredHistory);

  if (elRecordsCount) elRecordsCount.textContent = `${filteredHistory.length} Records in Selected Timeline Range (${rawTelemetryHistory.length} Total)`;
  if (elLastUpdate) elLastUpdate.textContent = `Last record: ${latest.Time || latest.Timestamp || new Date().toLocaleTimeString()}`;
}

function updateCharts(records) {
  if (!records || records.length === 0) return;

  // Downsample to max 120 points on chart for ultra-smooth 60fps rendering
  const maxChartPoints = 120;
  const step = Math.max(1, Math.floor(records.length / maxChartPoints));
  const sampledRecords = records.filter((_, idx) => idx % step === 0);

  const labels = [];
  const bmeTempData = [];
  const ahtTempData = [];
  const soilTempData = [];

  const bmeHumData = [];
  const ahtHumData = [];

  const capMoistData = [];
  const resMoistData = [];

  let prevMs = 0;
  const maxGapMs = 90000; // 90 Seconds Gap threshold = ESP32 Power Off / Disconnection!

  sampledRecords.forEach((r, idx) => {
    const currentMs = parseRecordTimestampMs(r);

    // GAP DETECTION: If gap between logs > 90 seconds, insert null gap to break line chart!
    if (prevMs > 0 && currentMs > 0 && (currentMs - prevMs > maxGapMs)) {
      labels.push("OFFLINE GAP");
      bmeTempData.push(null);
      ahtTempData.push(null);
      soilTempData.push(null);

      bmeHumData.push(null);
      ahtHumData.push(null);

      capMoistData.push(null);
      resMoistData.push(null);
    }

    prevMs = currentMs;

    let timeLabel = "";
    if (r.Time) {
      timeLabel = r.Time;
    } else if (r.Timestamp) {
      const parts = r.Timestamp.split("T");
      timeLabel = parts.length > 1 ? parts[1].replace("Z", "") : r.Timestamp;
    }

    labels.push(timeLabel);
    bmeTempData.push(r.BME_AirTemp_C ?? r.AirTemp_C ?? null);
    ahtTempData.push(r.AHT_AirTemp_C ?? r.AirTemp_C ?? null);
    soilTempData.push(r.SoilTemp_C ?? null);

    bmeHumData.push(r.BME_AirHumidity_Pct ?? r.AirHumidity_Pct ?? null);
    ahtHumData.push(r.AHT_AirHumidity_Pct ?? r.AirHumidity_Pct ?? null);

    capMoistData.push(r.CapMoisture_Pct ?? null);
    resMoistData.push(r.ResMoisture_Pct ?? null);
  });

  // 1. Temperature Chart
  if (temperatureChart) {
    temperatureChart.data.labels = labels;
    temperatureChart.data.datasets[0].data = bmeTempData;
    temperatureChart.data.datasets[1].data = ahtTempData;
    temperatureChart.data.datasets[2].data = soilTempData;
    temperatureChart.update();
  }

  // 2. Humidity Chart
  if (humidityChart) {
    humidityChart.data.labels = labels;
    humidityChart.data.datasets[0].data = bmeHumData;
    humidityChart.data.datasets[1].data = ahtHumData;
    humidityChart.update();
  }

  // 3. Soil Moisture Chart
  if (soilMoistureChart) {
    soilMoistureChart.data.labels = labels;
    soilMoistureChart.data.datasets[0].data = capMoistData;
    soilMoistureChart.data.datasets[1].data = resMoistData;
    soilMoistureChart.update();
  }
}

function updateTable(records) {
  if (!elTableBody) return;
  elTableBody.innerHTML = "";

  // Show all records in filtered range (up to 100 entries reversed)
  const reversed = [...records].reverse().slice(0, 100);

  reversed.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.Timestamp || r.Time || '--'}</td>
      <td>${formatNum(r.BME_AirTemp_C ?? r.AirTemp_C, 1)}°C</td>
      <td>${formatNum(r.AHT_AirTemp_C ?? r.AirTemp_C, 1)}°C</td>
      <td>${formatNum(r.SoilTemp_C, 1)}°C</td>
      <td>${formatNum(r.BME_AirHumidity_Pct ?? r.AirHumidity_Pct, 1)}%</td>
      <td>${formatNum(r.AHT_AirHumidity_Pct ?? r.AirHumidity_Pct, 1)}%</td>
      <td>${formatNum(r.CapMoisture_Pct, 0)}%</td>
      <td>${formatNum(r.ResMoisture_Pct, 0)}%</td>
      <td>${formatNum(r.BME_AirPressure_hPa ?? r.AirPressure_hPa, 1)}</td>
    `;
    elTableBody.appendChild(tr);
  });
}

function formatNum(val, decimals = 1) {
  if (val === undefined || val === null || isNaN(val)) return "--";
  return Number(val).toFixed(decimals);
}

// ============================================================================
// FILTERED CSV EXPORT ENGINE
// ============================================================================
function exportFilteredCsvLog() {
  if (filteredHistory.length === 0) {
    alert("No telemetry records in the selected timeline range to export.");
    return;
  }

  const headers = [
    "Timestamp", "Date", "Time", "BME_AirTemp_C", "AHT_AirTemp_C", "SoilTemp_C",
    "BME_AirHumidity_Pct", "AHT_AirHumidity_Pct", "BME_AirPressure_hPa",
    "CapMoisture_Raw", "ResMoisture_Raw", "CapMoisture_Pct", "ResMoisture_Pct", "SD_Status"
  ];

  let csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n";

  filteredHistory.forEach(r => {
    const row = [
      r.Timestamp || "",
      r.Date || "",
      r.Time || "",
      r.BME_AirTemp_C ?? r.AirTemp_C ?? "",
      r.AHT_AirTemp_C ?? r.AirTemp_C ?? "",
      r.SoilTemp_C ?? "",
      r.BME_AirHumidity_Pct ?? r.AirHumidity_Pct ?? "",
      r.AHT_AirHumidity_Pct ?? r.AirHumidity_Pct ?? "",
      r.BME_AirPressure_hPa ?? r.AirPressure_hPa ?? "",
      r.CapMoisture_Raw ?? "",
      r.ResMoisture_Raw ?? "",
      r.CapMoisture_Pct ?? "",
      r.ResMoisture_Pct ?? "",
      r.SD_Card_Status || "OK"
    ];
    csvContent += row.join(",") + "\n";
  });

  const rangeSuffix = activeRangeMode === "custom" ? "custom_range" : activeRangeMode;
  const fileName = `soil_air_telemetry_${new Date().toISOString().slice(0,10)}_${rangeSuffix}.csv`;

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ============================================================================
// DEMO SIMULATION (WITH INACTIVE GAP DEMONSTRATION)
// ============================================================================
function toggleDemoSimulation() {
  if (isDemoActive) {
    clearInterval(demoIntervalTimer);
    isDemoActive = false;
    if (elBtnDemo) {
      elBtnDemo.classList.remove("active");
      elBtnDemo.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i>`;
    }
    setConnectionState("offline", "Simulation Stopped");
    return;
  }

  isDemoActive = true;
  if (elBtnDemo) {
    elBtnDemo.classList.add("active");
    elBtnDemo.innerHTML = `<i class="fa-solid fa-stop"></i>`;
  }
  setConnectionState("online", "Live Demo Telemetry Streaming");

  const now = new Date();
  const demoRecords = [];

  // Generate 25 records with a simulated 15-minute power-off gap in the middle
  for (let i = 40; i >= 0; i--) {
    let offsetSec = i * 10;
    if (i > 20) offsetSec += 900; // Simulated 15-minute power off gap!
    const t = new Date(now.getTime() - offsetSec * 1000);
    demoRecords.push(generateSampleRecord(t));
  }

  rawTelemetryHistory = demoRecords;
  applyTimeFilter();

  demoIntervalTimer = setInterval(() => {
    const nextTime = new Date();
    const newRecord = generateSampleRecord(nextTime);
    rawTelemetryHistory.push(newRecord);
    applyTimeFilter();
  }, 3000);
}

function generateSampleRecord(dateObj) {
  const timeStr = dateObj.toTimeString().split(" ")[0];
  const isoStr = dateObj.toISOString();
  const tStep = dateObj.getTime() / 10000;

  const bmeTemp = 26.8 + 1.8 * Math.sin(tStep / 2) + (Math.random() * 0.3 - 0.15);
  const ahtTemp = 26.5 + 1.7 * Math.sin(tStep / 2) + (Math.random() * 0.2 - 0.1);
  const soilTemp = 24.1 + 0.7 * Math.sin(tStep / 3) + (Math.random() * 0.2 - 0.1);

  const bmeHum = 63.5 + 3.2 * Math.cos(tStep / 2) + (Math.random() * 0.5 - 0.25);
  const ahtHum = 64.8 + 3.0 * Math.cos(tStep / 2) + (Math.random() * 0.4 - 0.2);
  const bmePress = 1012.8 + 0.5 * Math.sin(tStep / 5);

  const capPct = Math.round(63 + 5 * Math.sin(tStep / 4) + (Math.random() * 2 - 1));
  const resPct = Math.round(59 + 7 * Math.sin(tStep / 3.5) + (Math.random() * 3 - 1.5));

  const capRaw = Math.round(3200 - (capPct / 100) * 1900);
  const resRaw = Math.round(3500 - (resPct / 100) * 2500);

  return {
    Timestamp: isoStr,
    Date: dateObj.toISOString().slice(0, 10),
    Time: timeStr,
    BME_AirTemp_C: Number(bmeTemp.toFixed(2)),
    AHT_AirTemp_C: Number(ahtTemp.toFixed(2)),
    SoilTemp_C: Number(soilTemp.toFixed(2)),
    BME_AirHumidity_Pct: Number(bmeHum.toFixed(2)),
    AHT_AirHumidity_Pct: Number(ahtHum.toFixed(2)),
    BME_AirPressure_hPa: Number(bmePress.toFixed(2)),
    CapMoisture_Pct: capPct,
    ResMoisture_Pct: resPct,
    CapMoisture_Raw: capRaw,
    ResMoisture_Raw: resRaw,
    SD_Card_Status: "OK"
  };
}
