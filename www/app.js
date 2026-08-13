// Dual Air & Soil Telemetry Studio Engine (v3.0 - Multi-Device, Bang-Bang Control & Max/Min Edition)

const FIREBASE_BASE_URL = "https://esp32-soil-and-air-default-rtdb.asia-southeast1.firebasedatabase.app/";
const FIREBASE_API_KEY = "AIzaSyD-E7fj6XtqIysg1MDztO2AfuaBV9an4fY";
const FIREBASE_USER_EMAIL = "apurbamaity227@gmail.com";
const FIREBASE_USER_PASSWORD = "Student@12er";

let activeFirebaseSuiteUrl = `${FIREBASE_BASE_URL}SensorData/SoilAirSuite.json`;
const FIREBASE_AHT_URL = `${FIREBASE_BASE_URL}SensorData/AHT20/History.json`;

// Firebase Authentication State
let firebaseIdToken = null;
let firebaseTokenExpiry = 0;

async function getFirebaseIdToken() {
  if (firebaseIdToken && Date.now() < firebaseTokenExpiry - 60000) {
    return firebaseIdToken;
  }

  const customEmail = localStorage.getItem("soil_air_user_email") || FIREBASE_USER_EMAIL;
  const customPass = localStorage.getItem("soil_air_user_pass") || FIREBASE_USER_PASSWORD;

  try {
    let authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: customEmail,
          password: customPass,
          returnSecureToken: true
        })
      }
    );

    if (!authRes.ok) {
      console.warn("Custom user authentication failed, trying default admin credentials...");
      authRes = await fetch(
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
    }

    if (authRes.ok) {
      const authData = await authRes.json();
      firebaseIdToken = authData.idToken;
      const expiresIn = parseInt(authData.expiresIn || "3600", 10);
      firebaseTokenExpiry = Date.now() + expiresIn * 1000;

      const elUserEmail = document.getElementById("user-email-display");
      if (elUserEmail) elUserEmail.textContent = customEmail;

      return firebaseIdToken;
    }

    throw new Error(`Auth failed with status ${authRes.status}`);
  } catch (err) {
    console.error("Firebase Auth Error:", err);
    return null;
  }
}

// Telemetry State
let rawTelemetryHistory = [];
let filteredHistory = [];

// ============================================================================
// RESILIENT FIREBASE POLLING ENGINE
// ============================================================================
async function startFirebasePolling() {
  await fetchTelemetryData();
  setInterval(fetchTelemetryData, 3000);
}

async function fetchTelemetryData() {
  if (isDemoActive) return;

  try {
    const token = await getFirebaseIdToken();
    const fetchUrl = token ? `${activeFirebaseSuiteUrl}?auth=${token}` : activeFirebaseSuiteUrl;
    const res = await fetch(fetchUrl);

    if (res.ok) {
      const data = await res.json();
      if (data && !data.error) {
        processFirebaseData(data);
        return;
      }
    } else {
      console.warn("Firebase HTTP status:", res.status);
    }

    if (rawTelemetryHistory.length > 0) {
      applyTimeFilter();
    } else {
      setConnectionState("offline", "Offline • Firebase Cloud Error");
    }
  } catch (err) {
    console.warn("Firebase fetch error, maintaining history view:", err);
    if (rawTelemetryHistory.length > 0) {
      applyTimeFilter();
    } else {
      setConnectionState("offline", "Offline • Network Connection Error");
    }
  }
}

// Telemetry State
let activeRangeMode = "24h";
let isDemoActive = false;
let demoIntervalTimer = null;

// Chart Instances
let temperatureChart = null;
let humidityChart = null;
let soilMoistureChart = null;
let pressureChart = null;

// DOM Elements
const elStatusBadge = document.getElementById("connection-status");
const elStatusText = document.getElementById("status-text");
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

// CSV Export Modal Elements
const elCsvExportModal = document.getElementById("csv-export-modal");
const elBtnCloseCsvModal = document.getElementById("btn-close-csv-modal");
const elBtnCancelCsv = document.getElementById("btn-cancel-csv");
const elBtnConfirmExportCsv = document.getElementById("btn-confirm-export-csv");
const elModalCustomDateContainer = document.getElementById("modal-custom-date-container");
const elModalDateFrom = document.getElementById("modal-date-from");
const elModalDateTo = document.getElementById("modal-date-to");

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
  try { initNavigation(); } catch(e) { console.error("Nav init error:", e); }
  try { initThemeSwitcher(); } catch(e) { console.error("Theme init error:", e); }
  try { initCharts(); } catch(e) { console.error("Chart init error:", e); }
  try { initTimelineControls(); } catch(e) { console.error("Timeline init error:", e); }
  try { initCsvModalControls(); } catch(e) { console.error("CSV init error:", e); }
  try { initGraphSubButtons(); } catch(e) { console.error("Graph buttons init error:", e); }
  try { initBangBangControls(); } catch(e) { console.error("Bang-Bang init error:", e); }
  try { initMultiDeviceManager(); } catch(e) { console.error("Multi-device init error:", e); }
  
  // Load cached telemetry history immediately to populate metrics, cards, & history
  try { loadCachedTelemetryData(); } catch(e) { console.error("Cache load error:", e); }

  // Poll Firebase to populate real-time metrics & updates
  try { startFirebasePolling(); } catch(e) { console.error("Polling error:", e); }

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
// CSV EXPORT MODAL & RANGE SELECTION CONTROLS
// ============================================================================
function initCsvModalControls() {
  const openModalButtons = document.querySelectorAll(".btn-open-csv-modal");
  openModalButtons.forEach(btn => {
    btn.addEventListener("click", openCsvExportModal);
  });

  if (elBtnCloseCsvModal) elBtnCloseCsvModal.addEventListener("click", closeCsvExportModal);
  if (elBtnCancelCsv) elBtnCancelCsv.addEventListener("click", closeCsvExportModal);

  const radioInputs = document.querySelectorAll('input[name="export-range"]');
  radioInputs.forEach(radio => {
    radio.addEventListener("change", (e) => {
      if (e.target.value === "custom") {
        if (elModalCustomDateContainer) elModalCustomDateContainer.classList.remove("hidden");
      } else {
        if (elModalCustomDateContainer) elModalCustomDateContainer.classList.add("hidden");
      }
    });
  });

  if (elBtnConfirmExportCsv) {
    elBtnConfirmExportCsv.addEventListener("click", executeSelectedCsvDownload);
  }
}

function openCsvExportModal() {
  if (elCsvExportModal) elCsvExportModal.classList.remove("hidden");
}

function closeCsvExportModal() {
  if (elCsvExportModal) elCsvExportModal.classList.add("hidden");
}

function executeSelectedCsvDownload() {
  const selectedRadio = document.querySelector('input[name="export-range"]:checked');
  const chosenRange = selectedRadio ? selectedRadio.value : "24h";

  let exportData = [];
  const now = Date.now();
  let cutoffMs = 0;

  if (chosenRange === "15m") {
    cutoffMs = now - (15 * 60 * 1000);
  } else if (chosenRange === "1h") {
    cutoffMs = now - (1 * 60 * 60 * 1000);
  } else if (chosenRange === "24h") {
    cutoffMs = now - (24 * 60 * 60 * 1000);
  } else if (chosenRange === "7d") {
    cutoffMs = now - (7 * 24 * 60 * 60 * 1000);
  } else if (chosenRange === "all") {
    cutoffMs = 0;
  } else if (chosenRange === "custom") {
    const fromTime = elModalDateFrom && elModalDateFrom.value ? new Date(elModalDateFrom.value).getTime() : 0;
    const toTime = elModalDateTo && elModalDateTo.value ? new Date(elModalDateTo.value).getTime() : Infinity;
    
    exportData = rawTelemetryHistory.filter(r => {
      const tMs = parseRecordTimestampMs(r);
      return tMs >= fromTime && tMs <= toTime;
    });
  }

  if (chosenRange !== "custom") {
    exportData = rawTelemetryHistory.filter(r => {
      const tMs = parseRecordTimestampMs(r);
      return tMs >= cutoffMs;
    });
  }

  // Fallback to raw history if range returned empty
  if (exportData.length === 0 && rawTelemetryHistory.length > 0) {
    exportData = rawTelemetryHistory;
  }

  if (exportData.length === 0) {
    alert("No telemetry records available to export for the chosen timeline range.");
    return;
  }

  // Generate CSV string
  const headers = [
    "Timestamp", "Date", "Time", "BME_AirTemp_C", "AHT_AirTemp_C", "SoilTemp_C",
    "BME_AirHumidity_Pct", "AHT_AirHumidity_Pct", "BME_AirPressure_hPa",
    "CapMoisture_Raw", "ResMoisture_Raw", "CapMoisture_Pct", "ResMoisture_Pct", "SD_Status"
  ];

  let csvRows = [];
  csvRows.push(headers.join(","));

  exportData.forEach(r => {
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
    csvRows.push(row.join(","));
  });

  const csvString = csvRows.join("\n");
  const fileName = `soil_air_telemetry_${new Date().toISOString().slice(0,10)}_${chosenRange}.csv`;

  closeCsvExportModal();

  // Multi-Engine Native Android & Mobile File Exporter
  triggerMultiEngineCsvDownload(csvString, fileName);
}

// MULTI-ENGINE CSV DOWNLOADER (Capacitor Native Filesystem -> Web Share API -> Blob URL -> Clipboard Copy Fallback)
async function triggerMultiEngineCsvDownload(csvString, fileName) {
  // 1. Native Android Capacitor Filesystem & Native Share Sheet Intent
  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    try {
      const Filesystem = window.Capacitor.Plugins.Filesystem;
      const Share = window.Capacitor.Plugins.Share;

      if (Filesystem) {
        const writeResult = await Filesystem.writeFile({
          path: fileName,
          data: csvString,
          directory: 'CACHE',
          encoding: 'utf8'
        });

        if (Share && writeResult && writeResult.uri) {
          await Share.share({
            title: "Soil & Air Telemetry CSV",
            text: `Exported telemetry log (${fileName})`,
            url: writeResult.uri,
            dialogTitle: "Save CSV File or Share via App"
          });
          return;
        }
      }
    } catch (nativeErr) {
      console.warn("Capacitor Native File Export Error:", nativeErr);
    }
  }

  // 2. Mobile Web Share API Fallback
  if (navigator.canShare && typeof File !== "undefined") {
    try {
      const file = new File([csvString], fileName, { type: "text/csv" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: "Soil & Air Telemetry CSV",
          files: [file]
        });
        return;
      }
    } catch (shareErr) {
      console.warn("Web Share API fallback to Blob download:", shareErr);
    }
  }

  // 3. Standard Browser Blob Download
  try {
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
  } catch (err) {
    console.error("Blob Download Error:", err);
    showCsvTextCopyModal(csvString, fileName);
  }
}

function showCsvTextCopyModal(csvString, fileName) {
  const modal = document.getElementById("csv-copy-modal");
  const textarea = document.getElementById("csv-text-area");
  const btnCopy = document.getElementById("btn-copy-csv-text");
  const btnClose = document.getElementById("btn-close-copy-modal");
  const btnCancel = document.getElementById("btn-cancel-copy");

  if (textarea) textarea.value = csvString;
  if (modal) modal.classList.remove("hidden");

  const closeModal = () => {
    if (modal) modal.classList.add("hidden");
  };

  if (btnClose) btnClose.onclick = closeModal;
  if (btnCancel) btnCancel.onclick = closeModal;

  if (btnCopy) {
    btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(csvString);
        btnCopy.innerHTML = `<i class="fa-solid fa-check"></i> Copied to Clipboard!`;
        setTimeout(() => {
          btnCopy.innerHTML = `<i class="fa-solid fa-clipboard"></i> 1-Tap Copy CSV`;
          closeModal();
        }, 1500);
      } catch (e) {
        textarea.select();
        document.execCommand("copy");
        alert("CSV data copied to clipboard!");
        closeModal();
      }
    };
  }
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
    updateDashboardUI();
    return;
  }

  const now = Date.now();
  let cutoffMs = 0;
  let summaryText = "";

  if (activeRangeMode === "15m") {
    cutoffMs = now - (15 * 60 * 1000);
    summaryText = "Realtime telemetry (Last 15 Min)";
  } else if (activeRangeMode === "1h") {
    cutoffMs = now - (1 * 60 * 60 * 1000);
    summaryText = "Last 1 hour of telemetry";
  } else if (activeRangeMode === "24h") {
    cutoffMs = now - (24 * 60 * 60 * 1000);
    summaryText = "Last 24 hours of telemetry";
  } else if (activeRangeMode === "7d") {
    cutoffMs = now - (7 * 24 * 60 * 60 * 1000);
    summaryText = "Last 7 days of telemetry";
  } else if (activeRangeMode === "all") {
    cutoffMs = 0;
    summaryText = `Full history log (${rawTelemetryHistory.length} total entries)`;
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

  // STOCK CHART / RESILIENT FALLBACK: If filtered history in strict last X hours is empty because ESP32 was off,
  // NEVER show a blank screen! Fallback to showing the latest historical records available in Firebase!
  if (filteredHistory.length === 0 && rawTelemetryHistory.length > 0) {
    filteredHistory = rawTelemetryHistory.slice(-50);
    summaryText += ` (Showing latest ${filteredHistory.length} historical logs)`;
  }

  if (elFilterSummaryText) elFilterSummaryText.textContent = summaryText;
  updateDashboardUI();
}

function parseRecordTimestampMs(r) {
  if (!r) return 0;
  if (r.Date && r.Time) {
    const d = new Date(`${r.Date}T${r.Time}`);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  if (r.Timestamp) {
    const cleanStamp = r.Timestamp.replace("Z", "");
    const d = new Date(cleanStamp);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

// ============================================================================
// DYNAMIC ESP32 POWER & HEARTBEAT STALENESS ENGINE
// ============================================================================
let lastRecordReceivedTime = 0;
let lastKnownLiveStamp = null;

function checkEspHeartbeatStatus(latestRecord) {
  if (!latestRecord) {
    setConnectionState("offline", "ESP32 Offline (No Data)");
    updateHeartbeatUI(false, "DISCONNECTED", "No Data", "badge-err");
    return;
  }

  const currentStamp = latestRecord.Timestamp || latestRecord.Time || JSON.stringify(latestRecord);
  
  // Track when a NEW live record payload actually arrives from the ESP32
  if (lastKnownLiveStamp !== null && lastKnownLiveStamp !== currentStamp) {
    lastRecordReceivedTime = Date.now();
  }
  lastKnownLiveStamp = currentStamp;

  let timeString = latestRecord._rawTime || latestRecord.Time || "";
  if (!timeString && latestRecord.Timestamp) {
    const parts = latestRecord.Timestamp.split("T");
    if (parts.length > 1) timeString = parts[1].replace("Z", "");
  }

  const isTransmittingNow = (lastRecordReceivedTime > 0) && (Date.now() - lastRecordReceivedTime < 45000);

  if (isTransmittingNow) {
    // 🟢 ESP32 IS ON AND TRANSMITTING LIVE
    setConnectionState("online", "ESP32 Live Stream Active");
    updateHeartbeatUI(true, "ACTIVE (Transmitting)", `Live (${timeString || "Just now"})`, "badge-optimal");
  } else {
    // 🔴 ESP32 IS OFF / INACTIVE (Displaying Previous History)
    let agoText = "Offline";
    const recordMs = parseRecordTimestampMs(latestRecord);
    if (recordMs > 0) {
      const ageMin = Math.floor(Math.abs(Date.now() - recordMs) / 60000);
      const ageHours = Math.floor(ageMin / 60);
      agoText = ageMin < 60 ? `${ageMin}m ago` : `${ageHours}h ${ageMin % 60}m ago`;
    }
    
    const lastTimeDisplay = timeString ? `${timeString} (${agoText})` : agoText;
    setConnectionState("offline", `Offline • Last logged: ${lastTimeDisplay}`);
    updateHeartbeatUI(false, `INACTIVE (${agoText})`, `Last logged: ${lastTimeDisplay}`, "badge-err");
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

function updateSdHealthBadge(statusMsg, isEspActive = false) {
  if (!elSdStatus) return;
  
  if (statusMsg === "OK") {
    elSdStatus.textContent = isEspActive ? "LOGGING (10s)" : "OFFLINE (Last: OK)";
    elSdStatus.style.color = "#34d399";
    if (elSdIcon) elSdIcon.className = "fa-solid fa-sd-card color-hum";
    if (elSdDiagBadge) {
      elSdDiagBadge.textContent = isEspActive ? "ONLINE (FAT32 OK)" : "OFFLINE (Last: OK)";
      elSdDiagBadge.className = "badge badge-optimal";
    }
  } else {
    elSdStatus.textContent = isEspActive ? `ERR (${statusMsg})` : `OFFLINE (Last: ${statusMsg})`;
    elSdStatus.style.color = "#f87171";
    if (elSdIcon) elSdIcon.className = "fa-solid fa-triangle-exclamation color-temp";
    if (elSdDiagBadge) {
      elSdDiagBadge.textContent = isEspActive ? `ERR: ${statusMsg}` : `OFFLINE (Last: ${statusMsg})`;
      elSdDiagBadge.className = "badge badge-err";
    }
  }
}

// ============================================================================
// CHART INITIALIZATION
// ============================================================================
function initCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js engine not available, waveforms disabled.");
    return;
  }

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    spanGaps: false, // Breaks line graph during power-off gaps
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

  try {
    // 1. Temperature Comparison
    const elTempCanvas = document.getElementById("temperatureChart");
    if (elTempCanvas) {
      const ctxTemp = elTempCanvas.getContext("2d");
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

  // 2. Humidity Comparison
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

  // 3. Soil Moisture Comparison
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

  // 4. Atmospheric Pressure Waveform
  const elPressCanvas = document.getElementById("pressureChart");
  if (elPressCanvas) {
    const ctxPress = elPressCanvas.getContext("2d");
    pressureChart = new Chart(ctxPress, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Atmospheric Pressure (hPa)",
            borderColor: "#a855f7",
            backgroundColor: "rgba(168, 85, 247, 0.12)",
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
}

// ============================================================================
// RESILIENT FIREBASE POLLING ENGINE
// ============================================================================
async function startFirebasePolling() {
  fetchTelemetryData();
  setInterval(fetchTelemetryData, 3000);
}

async function fetchTelemetryData() {
  if (isDemoActive) return;

  try {
    // Attempt direct fetch with existing token or unauthenticated first (unblocks startup)
    const token = firebaseIdToken;
    const fetchUrl = token ? `${activeFirebaseSuiteUrl}?auth=${token}` : activeFirebaseSuiteUrl;
    let res = await fetch(fetchUrl);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        const newToken = await getFirebaseIdToken();
        if (newToken) {
          res = await fetch(`${activeFirebaseSuiteUrl}?auth=${newToken}`);
        }
      }
    }

    if (res && res.ok) {
      const data = await res.json();
      if (data && !data.error) {
        processFirebaseData(data);
        return;
      }
    }

    // Fallback: If network or Firebase returned error
    if (rawTelemetryHistory.length > 0) {
      applyTimeFilter();
    } else {
      setConnectionState("offline", "Offline • Cloud Data Unavailable");
    }
  } catch (err) {
    console.warn("Firebase fetch error, maintaining history view:", err);
    if (rawTelemetryHistory.length > 0) {
      applyTimeFilter();
    } else {
      setConnectionState("offline", "Offline • Network Connection Timeout");
    }
  }
}

function processFirebaseData(data) {
  if (!data || data.error) {
    console.warn("Firebase returned error or null:", data?.error);
    if (rawTelemetryHistory.length === 0) {
      updateEmptyDeviceState();
    }
    return;
  }

  let historyList = [];

  // 1. Check if data contains .History object wrapper
  if (data.History && typeof data.History === "object") {
    historyList = Object.values(data.History);
  } 
  // 2. Check if data is a direct Array
  else if (Array.isArray(data)) {
    historyList = [...data];
  } 
  // 3. Check if data is a direct push-ID map: {"-Oz1...": {...}, "-Oz2...": {...}}
  else if (typeof data === "object") {
    const vals = Object.values(data).filter(v => v && typeof v === "object");
    const sample = vals[0];
    if (sample && (sample.BME_AirTemp_C !== undefined || sample.AirTemp_C !== undefined || sample.AHT_AirTemp_C !== undefined || sample.Timestamp || sample.Time || sample.SoilTemp_C !== undefined)) {
      historyList = vals;
    }
  }

  // Preserve natural Firebase push order (Firebase push keys are chronologically monotonic)
  // 4. Append .Live record if present (ALWAYS place at end of array as absolute latest)
  if (data.Live && typeof data.Live === "object") {
    const liveRec = { ...data.Live };
    if (!liveRec.Date || liveRec.Date.startsWith("2000") || liveRec.Date.startsWith("1970")) {
      liveRec._rawTime = liveRec.Time;
      liveRec._unsyncedRtc = true;
    }
    const lastHistStamp = historyList.length > 0 ? (historyList[historyList.length - 1].Timestamp || historyList[historyList.length - 1].Time) : null;
    if (!lastHistStamp || lastHistStamp !== (liveRec.Timestamp || liveRec.Time)) {
      historyList.push(liveRec);
    }
    if (data.Live.SD_Card_Status) {
      const isEspActive = (lastRecordReceivedTime > 0) && (Date.now() - lastRecordReceivedTime < 45000);
      updateSdHealthBadge(data.Live.SD_Card_Status, isEspActive);
    }
  }

  if (historyList.length > 0) {
    rawTelemetryHistory = historyList;
    
    // Save to localStorage cache so mobile app loads instantly on cold start
    try {
      localStorage.setItem(`soil_air_cache_${activeDeviceId}`, JSON.stringify(historyList.slice(-200)));
    } catch (e) {}

    const elStatusBox = document.getElementById("active-device-status-box");
    if (elStatusBox) {
      elStatusBox.innerHTML = `<span class="badge badge-optimal">ONLINE STREAM</span>`;
    }
    applyTimeFilter();
  } else {
    if (rawTelemetryHistory.length === 0) {
      updateEmptyDeviceState();
    }
  }
}

function loadCachedTelemetryData() {
  try {
    const cachedStr = localStorage.getItem(`soil_air_cache_${activeDeviceId}`);
    if (cachedStr) {
      const cachedList = JSON.parse(cachedStr);
      if (Array.isArray(cachedList) && cachedList.length > 0) {
        rawTelemetryHistory = cachedList;
        applyTimeFilter();
      }
    }
  } catch (e) {}
}

function updateEmptyDeviceState() {
  const cur = (typeof registeredDevices !== 'undefined') ? (registeredDevices.find(d => d.id === activeDeviceId) || registeredDevices[0]) : null;
  const devName = cur ? cur.name : activeDeviceId;
  const devPath = cur ? cur.path : activeDeviceId;

  setConnectionState("offline", `No Hardware Stream • Waiting for data at ${devPath}`);
  updateHeartbeatUI(false, "NO HARDWARE STREAM", `No data on path ${devPath}`, "badge-stale");

  const elStatusBox = document.getElementById("active-device-status-box");
  if (elStatusBox) {
    elStatusBox.innerHTML = `<span class="badge badge-stale"><i class="fa-solid fa-plug-circle-xmark"></i> NO STREAM YET</span>`;
  }

  if (elBmeTemp) elBmeTemp.innerHTML = `-- <span class="unit">°C</span>`;
  if (elAhtTemp) elAhtTemp.innerHTML = `-- <span class="unit">°C</span>`;
  if (elSoilTemp) elSoilTemp.innerHTML = `-- <span class="unit">°C</span>`;
  if (elBmeHum) elBmeHum.innerHTML = `-- <span class="unit">%</span>`;
  if (elAhtHum) elAhtHum.innerHTML = `-- <span class="unit">%</span>`;
  if (elCapMoist) elCapMoist.innerHTML = `-- <span class="unit">%</span>`;
  if (elResMoist) elResMoist.innerHTML = `-- <span class="unit">%</span>`;
  if (elCapRaw) elCapRaw.textContent = "--";
  if (elResRaw) elResRaw.textContent = "--";
  if (elBmePress) elBmePress.innerHTML = `-- <span class="unit">hPa</span>`;

  const setElText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  ["bme-temp", "aht-temp", "soil-temp", "bme-hum", "aht-hum", "cap-moist", "res-moist", "bme-press"].forEach(k => {
    setElText(`max-${k}`, "--");
    setElText(`min-${k}`, "--");
  });

  if (elRecordsCount) elRecordsCount.textContent = `0 Records Loaded (No Hardware Stream)`;
  if (elLastUpdate) elLastUpdate.textContent = `Waiting for stream at ${devPath}...`;
  if (elTableBody) elTableBody.innerHTML = `<tr><td colspan="9" class="empty-state">No hardware telemetry recorded for <strong>${devName} (${activeDeviceId})</strong> yet.<br>Connect physical hardware to publish to Firebase path: <code>${devPath}</code></td></tr>`;

  if (temperatureChart) { temperatureChart.data.labels = []; temperatureChart.data.datasets.forEach(d => d.data = []); temperatureChart.update(); }
  if (humidityChart) { humidityChart.data.labels = []; humidityChart.data.datasets.forEach(d => d.data = []); humidityChart.update(); }
  if (soilMoistureChart) { soilMoistureChart.data.labels = []; soilMoistureChart.data.datasets.forEach(d => d.data = []); soilMoistureChart.update(); }
  if (pressureChart) { pressureChart.data.labels = []; pressureChart.data.datasets.forEach(d => d.data = []); pressureChart.update(); }
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

  if (rawTelemetryHistory.length > 0) {
    applyTimeFilter();
  }
}

// ============================================================================
// UI UPDATES & STOCK CHART TIME GAP PLOTTING
// ============================================================================
function updateDashboardUI() {
  if (rawTelemetryHistory.length === 0) return;

  const displayHistory = filteredHistory.length > 0 ? filteredHistory : rawTelemetryHistory;
  const latest = displayHistory[displayHistory.length - 1];

  checkEspHeartbeatStatus(latest);

  if (latest.SD_Card_Status) {
    updateSdHealthBadge(latest.SD_Card_Status);
  }

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

  // Compute & Display Maximum and Minimum Stats for current window
  updateMetricsStats(displayHistory);

  // Evaluate Bang-Bang Controller Logic
  evaluateBangBangController(latest);

  updateCharts(displayHistory);
  updateTable(displayHistory);

  if (elRecordsCount) elRecordsCount.textContent = `${displayHistory.length} Records Loaded (${rawTelemetryHistory.length} Total)`;
  if (elLastUpdate) elLastUpdate.textContent = `Last record: ${latest.Time || latest.Timestamp || new Date().toLocaleTimeString()}`;
}

function updateMetricsStats(records) {
  if (!records || records.length === 0) return;

  const getMinMax = (prop) => {
    const vals = records
      .map(r => r[prop] ?? (prop.includes("Temp") ? r.AirTemp_C : (prop.includes("Humidity") ? r.AirHumidity_Pct : r.AirPressure_hPa)))
      .filter(v => v !== undefined && v !== null && !isNaN(v));
    if (vals.length === 0) return { min: "--", max: "--" };
    return { min: Math.min(...vals), max: Math.max(...vals) };
  };

  const setElText = (id, val, dec = 1) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = (val === "--" || val === undefined || isNaN(val)) ? "--" : Number(val).toFixed(dec);
    }
  };

  const sBmeTemp = getMinMax("BME_AirTemp_C");
  const sAhtTemp = getMinMax("AHT_AirTemp_C");
  const sSoilTemp = getMinMax("SoilTemp_C");
  const sBmeHum = getMinMax("BME_AirHumidity_Pct");
  const sAhtHum = getMinMax("AHT_AirHumidity_Pct");
  const sCapMoist = getMinMax("CapMoisture_Pct");
  const sResMoist = getMinMax("ResMoisture_Pct");
  const sBmePress = getMinMax("BME_AirPressure_hPa");

  setElText("max-bme-temp", sBmeTemp.max, 1);
  setElText("min-bme-temp", sBmeTemp.min, 1);
  setElText("max-aht-temp", sAhtTemp.max, 1);
  setElText("min-aht-temp", sAhtTemp.min, 1);
  setElText("max-soil-temp", sSoilTemp.max, 1);
  setElText("min-soil-temp", sSoilTemp.min, 1);

  setElText("max-bme-hum", sBmeHum.max, 1);
  setElText("min-bme-hum", sBmeHum.min, 1);
  setElText("max-aht-hum", sAhtHum.max, 1);
  setElText("min-aht-hum", sAhtHum.min, 1);

  setElText("max-cap-moist", sCapMoist.max, 0);
  setElText("min-cap-moist", sCapMoist.min, 0);
  setElText("max-res-moist", sResMoist.max, 0);
  setElText("min-res-moist", sResMoist.min, 0);

  setElText("max-bme-press", sBmePress.max, 1);
  setElText("min-bme-press", sBmePress.min, 1);
}

function updateCharts(records) {
  if (!records || records.length === 0) return;

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
  const pressData = [];

  let prevMs = 0;
  const maxGapMs = 90000;

  sampledRecords.forEach((r) => {
    const currentMs = parseRecordTimestampMs(r);

    if (prevMs > 0 && currentMs > 0 && (currentMs - prevMs > maxGapMs)) {
      labels.push("OFFLINE GAP");
      bmeTempData.push(null);
      ahtTempData.push(null);
      soilTempData.push(null);

      bmeHumData.push(null);
      ahtHumData.push(null);

      capMoistData.push(null);
      resMoistData.push(null);
      pressData.push(null);
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
    pressData.push(r.BME_AirPressure_hPa ?? r.AirPressure_hPa ?? null);
  });

  const lastRecordMs = prevMs;
  const nowMs = Date.now();
  if (lastRecordMs > 0 && (nowMs - lastRecordMs > 60000)) {
    const nowTimeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    labels.push("OFFLINE GAP");
    labels.push(`Now (${nowTimeStr})`);

    bmeTempData.push(null); bmeTempData.push(null);
    ahtTempData.push(null); ahtTempData.push(null);
    soilTempData.push(null); soilTempData.push(null);

    bmeHumData.push(null); bmeHumData.push(null);
    ahtHumData.push(null); ahtHumData.push(null);

    capMoistData.push(null); capMoistData.push(null);
    resMoistData.push(null); resMoistData.push(null);
    pressData.push(null); pressData.push(null);
  }

  if (temperatureChart) {
    temperatureChart.data.labels = labels;
    temperatureChart.data.datasets[0].data = bmeTempData;
    temperatureChart.data.datasets[1].data = ahtTempData;
    temperatureChart.data.datasets[2].data = soilTempData;
    temperatureChart.update();
  }

  if (humidityChart) {
    humidityChart.data.labels = labels;
    humidityChart.data.datasets[0].data = bmeHumData;
    humidityChart.data.datasets[1].data = ahtHumData;
    humidityChart.update();
  }

  if (soilMoistureChart) {
    soilMoistureChart.data.labels = labels;
    soilMoistureChart.data.datasets[0].data = capMoistData;
    soilMoistureChart.data.datasets[1].data = resMoistData;
    soilMoistureChart.update();
  }

  if (pressureChart) {
    pressureChart.data.labels = labels;
    pressureChart.data.datasets[0].data = pressData;
    pressureChart.update();
  }
}

function updateTable(records) {
  if (!elTableBody) return;
  elTableBody.innerHTML = "";

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
// DEMO SIMULATION
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

  for (let i = 40; i >= 0; i--) {
    let offsetSec = i * 10;
    if (i > 20) offsetSec += 900;
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

// ============================================================================
// GRAPH PARAMETER SUB-BUTTONS FILTER MODULE
// ============================================================================
function initGraphSubButtons() {
  const filterContainer = document.getElementById("graph-parameter-filters");
  if (!filterContainer) return;

  const pills = filterContainer.querySelectorAll(".sub-pill");
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      const filter = pill.getAttribute("data-filter");
      applyGraphFilter(filter);
    });
  });
}

function applyGraphFilter(filter) {
  const cardTemp = document.getElementById("card-chart-temp");
  const cardHum = document.getElementById("card-chart-hum");
  const cardSoil = document.getElementById("card-chart-soil");
  const cardPress = document.getElementById("card-chart-press");

  const allCards = [cardTemp, cardHum, cardSoil, cardPress];
  allCards.forEach(c => { if (c) c.classList.remove("hidden-card"); });

  if (filter === "temp") {
    if (cardHum) cardHum.classList.add("hidden-card");
    if (cardSoil) cardSoil.classList.add("hidden-card");
    if (cardPress) cardPress.classList.add("hidden-card");
  } else if (filter === "hum") {
    if (cardTemp) cardTemp.classList.add("hidden-card");
    if (cardSoil) cardSoil.classList.add("hidden-card");
    if (cardPress) cardPress.classList.add("hidden-card");
  } else if (filter === "soil") {
    if (cardTemp) cardTemp.classList.add("hidden-card");
    if (cardHum) cardHum.classList.add("hidden-card");
    if (cardPress) cardPress.classList.add("hidden-card");
  } else if (filter === "press") {
    if (cardTemp) cardTemp.classList.add("hidden-card");
    if (cardHum) cardHum.classList.add("hidden-card");
    if (cardSoil) cardSoil.classList.add("hidden-card");
  }
}

// ============================================================================
// BANG-BANG HYSTERESIS CONTROLLER MODULE
// ============================================================================
let bangBangConfig = {
  autoIrrigation: true,
  autoFan: true,
  moistOn: 35,
  moistOff: 75,
  tempOn: 32,
  tempOff: 27,
  relays: { 1: false, 2: false, 3: false, 4: false }
};

function initBangBangControls() {
  const saved = localStorage.getItem("soil_air_bang_bang");
  if (saved) {
    try { bangBangConfig = { ...bangBangConfig, ...JSON.parse(saved) }; } catch(e) {}
  }

  const rngMoistOn = document.getElementById("rng-moist-on");
  const rngMoistOff = document.getElementById("rng-moist-off");
  const dispMoistOn = document.getElementById("disp-moist-on");
  const dispMoistOff = document.getElementById("disp-moist-off");

  const rngTempOn = document.getElementById("rng-temp-on");
  const rngTempOff = document.getElementById("rng-temp-off");
  const dispTempOn = document.getElementById("disp-temp-on");
  const dispTempOff = document.getElementById("disp-temp-off");

  const chkIrrigation = document.getElementById("chk-auto-irrigation");
  const chkFan = document.getElementById("chk-auto-fan");

  if (rngMoistOn) {
    rngMoistOn.value = bangBangConfig.moistOn;
    if (dispMoistOn) dispMoistOn.textContent = `${bangBangConfig.moistOn}%`;
    rngMoistOn.addEventListener("input", (e) => {
      bangBangConfig.moistOn = parseInt(e.target.value, 10);
      if (dispMoistOn) dispMoistOn.textContent = `${bangBangConfig.moistOn}%`;
      saveBangBangConfig();
    });
  }

  if (rngMoistOff) {
    rngMoistOff.value = bangBangConfig.moistOff;
    if (dispMoistOff) dispMoistOff.textContent = `${bangBangConfig.moistOff}%`;
    rngMoistOff.addEventListener("input", (e) => {
      bangBangConfig.moistOff = parseInt(e.target.value, 10);
      if (dispMoistOff) dispMoistOff.textContent = `${bangBangConfig.moistOff}%`;
      saveBangBangConfig();
    });
  }

  if (rngTempOn) {
    rngTempOn.value = bangBangConfig.tempOn;
    if (dispTempOn) dispTempOn.textContent = `${bangBangConfig.tempOn}°C`;
    rngTempOn.addEventListener("input", (e) => {
      bangBangConfig.tempOn = parseInt(e.target.value, 10);
      if (dispTempOn) dispTempOn.textContent = `${bangBangConfig.tempOn}°C`;
      saveBangBangConfig();
    });
  }

  if (rngTempOff) {
    rngTempOff.value = bangBangConfig.tempOff;
    if (dispTempOff) dispTempOff.textContent = `${bangBangConfig.tempOff}°C`;
    rngTempOff.addEventListener("input", (e) => {
      bangBangConfig.tempOff = parseInt(e.target.value, 10);
      if (dispTempOff) dispTempOff.textContent = `${bangBangConfig.tempOff}°C`;
      saveBangBangConfig();
    });
  }

  if (chkIrrigation) {
    chkIrrigation.checked = bangBangConfig.autoIrrigation;
    chkIrrigation.addEventListener("change", (e) => {
      bangBangConfig.autoIrrigation = e.target.checked;
      saveBangBangConfig();
    });
  }

  if (chkFan) {
    chkFan.checked = bangBangConfig.autoFan;
    chkFan.addEventListener("change", (e) => {
      bangBangConfig.autoFan = e.target.checked;
      saveBangBangConfig();
    });
  }

  // Manual Relay Toggle Buttons
  const relayBtns = document.querySelectorAll(".btn-toggle-relay");
  relayBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const relayId = btn.getAttribute("data-relay");
      bangBangConfig.relays[relayId] = !bangBangConfig.relays[relayId];
      saveBangBangConfig();
      updateRelaysUI();
      pushRelayStatesToFirebase();
    });
  });

  updateRelaysUI();
}

function saveBangBangConfig() {
  localStorage.setItem("soil_air_bang_bang", JSON.stringify(bangBangConfig));
}

function evaluateBangBangController(latestRecord) {
  if (!latestRecord) return;
  const moist = latestRecord.CapMoisture_Pct ?? latestRecord.ResMoisture_Pct ?? 50;
  const temp = latestRecord.BME_AirTemp_C ?? latestRecord.AHT_AirTemp_C ?? latestRecord.AirTemp_C ?? 25;

  const elValPump = document.getElementById("val-pump-relay");
  const elValFan = document.getElementById("val-fan-relay");

  // Irrigation Hysteresis (ON when moisture <= lower setpoint, OFF when moisture >= upper setpoint)
  if (bangBangConfig.autoIrrigation) {
    if (moist <= bangBangConfig.moistOn) {
      bangBangConfig.relays[1] = true;
    } else if (moist >= bangBangConfig.moistOff) {
      bangBangConfig.relays[1] = false;
    }
  }

  // Cooling Fan Hysteresis (ON when temp >= upper setpoint, OFF when temp <= lower setpoint)
  if (bangBangConfig.autoFan) {
    if (temp >= bangBangConfig.tempOn) {
      bangBangConfig.relays[2] = true;
    } else if (temp <= bangBangConfig.tempOff) {
      bangBangConfig.relays[2] = false;
    }
  }

  if (elValPump) {
    elValPump.textContent = bangBangConfig.relays[1] ? "ON (Irrigating Soil)" : "OFF (Moisture Normal)";
    elValPump.className = bangBangConfig.relays[1] ? "state-on" : "state-off";
  }

  if (elValFan) {
    elValFan.textContent = bangBangConfig.relays[2] ? "ON (Cooling Active)" : "OFF (Temp Normal)";
    elValFan.className = bangBangConfig.relays[2] ? "state-on" : "state-off";
  }

  updateRelaysUI();
}

function updateRelaysUI() {
  for (let i = 1; i <= 4; i++) {
    const card = document.getElementById(`relay-card-${i}`);
    if (card) {
      if (bangBangConfig.relays[i]) {
        card.classList.add("active-relay");
      } else {
        card.classList.remove("active-relay");
      }
    }
  }
}

async function pushRelayStatesToFirebase() {
  try {
    const token = await getFirebaseIdToken();
    const url = `${FIREBASE_BASE_URL}Control/Relays.json${token ? `?auth=${token}` : ''}`;
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bangBangConfig.relays)
    });
  } catch (e) {}
}

// ============================================================================
// USER ACCOUNT & MULTI-DEVICE MANAGEMENT MODULE
// ============================================================================
let registeredDevices = [
  { id: "ESP32-SOIL-AIR-01", name: "ESP32 Main Suite", path: "SensorData/SoilAirSuite", type: "ESP32" },
  { id: "ESP32-GREENHOUSE-02", name: "Greenhouse Polyhouse Node", path: "SensorData/Greenhouse02", type: "ESP32" }
];
let activeDeviceId = "ESP32-SOIL-AIR-01";

function initMultiDeviceManager() {
  const savedDevs = localStorage.getItem("soil_air_devices");
  if (savedDevs) {
    try { registeredDevices = JSON.parse(savedDevs); } catch (e) {}
  }
  const savedActive = localStorage.getItem("soil_air_active_dev_id");
  if (savedActive) activeDeviceId = savedActive;

  renderDevicesList();
  updateActiveDeviceBanner();

  // Account Form Toggles
  const btnToggleAcc = document.getElementById("btn-toggle-account-form");
  const accFormBox = document.getElementById("account-form-box");
  const btnSaveAcc = document.getElementById("btn-save-account-login");
  const btnRefreshAuth = document.getElementById("btn-refresh-auth-token");
  const btnSignOut = document.getElementById("btn-signout-account");

  const storedUserEmail = localStorage.getItem("soil_air_user_email") || FIREBASE_USER_EMAIL;
  const elUserEmailDisp = document.getElementById("user-email-display");
  if (elUserEmailDisp) elUserEmailDisp.textContent = storedUserEmail;

  if (btnToggleAcc && accFormBox) {
    btnToggleAcc.addEventListener("click", () => {
      accFormBox.classList.toggle("hidden");
    });
  }

  if (btnSaveAcc) {
    btnSaveAcc.addEventListener("click", async () => {
      const email = document.getElementById("input-account-email")?.value.trim();
      const pass = document.getElementById("input-account-pass")?.value.trim();
      if (!email || !pass) {
        alert("Please enter both email and password.");
        return;
      }
      localStorage.setItem("soil_air_user_email", email);
      localStorage.setItem("soil_air_user_pass", pass);
      firebaseIdToken = null;

      const t = await getFirebaseIdToken();
      if (t) {
        if (elUserEmailDisp) elUserEmailDisp.textContent = email;
        const badgeUser = document.getElementById("badge-user-status");
        if (badgeUser) { badgeUser.textContent = "Authenticated"; badgeUser.className = "badge badge-optimal"; }
        accFormBox.classList.add("hidden");
        alert(`Successfully authenticated as ${email}!`);
      } else {
        alert("Authentication failed. Please verify email and password.");
      }
    });
  }

  if (btnSignOut) {
    btnSignOut.addEventListener("click", () => {
      localStorage.removeItem("soil_air_user_email");
      localStorage.removeItem("soil_air_user_pass");
      firebaseIdToken = null;
      if (elUserEmailDisp) elUserEmailDisp.textContent = "Guest / Unauthenticated";
      const badgeUser = document.getElementById("badge-user-status");
      if (badgeUser) { badgeUser.textContent = "Guest Mode"; badgeUser.className = "badge badge-stale"; }
      alert("Signed out of custom Firebase account session.");
    });
  }

  if (btnRefreshAuth) {
    btnRefreshAuth.addEventListener("click", async () => {
      firebaseIdToken = null;
      const t = await getFirebaseIdToken();
      alert(t ? "Firebase security token refreshed!" : "Failed to refresh token.");
    });
  }

  // Add Device Modal Controls
  const modalAddDev = document.getElementById("add-device-modal");
  const btnOpenAddDev = document.getElementById("btn-open-add-device");
  const btnCloseDev = document.getElementById("btn-close-device-modal");
  const btnCancelDev = document.getElementById("btn-cancel-device");
  const btnSaveDev = document.getElementById("btn-save-new-device");

  if (btnOpenAddDev && modalAddDev) {
    btnOpenAddDev.addEventListener("click", () => modalAddDev.classList.remove("hidden"));
  }
  const closeModal = () => { if (modalAddDev) modalAddDev.classList.add("hidden"); };
  if (btnCloseDev) btnCloseDev.addEventListener("click", closeModal);
  if (btnCancelDev) btnCancelDev.addEventListener("click", closeModal);

  if (btnSaveDev) {
    btnSaveDev.addEventListener("click", () => {
      const name = document.getElementById("new-dev-name")?.value.trim();
      const id = document.getElementById("new-dev-id")?.value.trim();
      const type = document.getElementById("new-dev-type")?.value;
      const path = document.getElementById("new-dev-path")?.value.trim() || `SensorData/${id}`;

      if (!name || !id) {
        alert("Please provide a Device Name and Unique Device ID.");
        return;
      }

      const existing = registeredDevices.find(d => d.id === id);
      if (existing) {
        alert("A device with this Unique ID already exists.");
        return;
      }

      const newDev = { id, name, type, path };
      registeredDevices.push(newDev);
      localStorage.setItem("soil_air_devices", JSON.stringify(registeredDevices));
      
      closeModal();
      renderDevicesList();
      switchActiveDevice(id);
    });
  }
}

function renderDevicesList() {
  const container = document.getElementById("devices-list-container");
  if (!container) return;
  container.innerHTML = "";

  registeredDevices.forEach(dev => {
    const card = document.createElement("div");
    const isActive = dev.id === activeDeviceId;
    card.className = `device-card ${isActive ? 'is-active-device' : ''}`;
    card.innerHTML = `
      <div class="device-card-header">
        <h4>${dev.name}</h4>
        <span class="device-type-badge">${dev.type || 'ESP32'}</span>
      </div>
      <code>ID: ${dev.id}</code>
      <p class="dev-path">Path: <code>${dev.path}</code></p>
      <div class="device-card-actions">
        ${isActive 
          ? `<span class="badge badge-optimal"><i class="fa-solid fa-check"></i> ACTIVE</span>` 
          : `<button class="btn btn-secondary btn-sm btn-switch-dev" data-id="${dev.id}"><i class="fa-solid fa-play"></i> Switch Active</button>`
        }
      </div>
    `;
    container.appendChild(card);
  });

  const switchBtns = container.querySelectorAll(".btn-switch-dev");
  switchBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const devId = btn.getAttribute("data-id");
      switchActiveDevice(devId);
    });
  });
}

function switchActiveDevice(devId) {
  const target = registeredDevices.find(d => d.id === devId);
  if (!target) return;

  activeDeviceId = devId;
  localStorage.setItem("soil_air_active_dev_id", activeDeviceId);

  // Update active Firebase URL
  const cleanPath = target.path.endsWith('.json') ? target.path : `${target.path}.json`;
  activeFirebaseSuiteUrl = `${FIREBASE_BASE_URL}${cleanPath}`;

  updateActiveDeviceBanner();
  renderDevicesList();

  rawTelemetryHistory = [];
  filteredHistory = [];
  loadCachedTelemetryData();
  fetchTelemetryData();
}

function updateActiveDeviceBanner() {
  const cur = registeredDevices.find(d => d.id === activeDeviceId) || registeredDevices[0];
  if (!cur) return;

  const elName = document.getElementById("active-device-name");
  const elId = document.getElementById("active-device-id");
  const elPath = document.getElementById("active-device-path");

  if (elName) elName.textContent = cur.name;
  if (elId) elId.textContent = `ID: ${cur.id}`;
  if (elPath) elPath.innerHTML = `Firebase Path: <code>${cur.path}</code>`;
}

// ============================================================================
// APP THEME & VISUAL APPEARANCE ENGINE
// ============================================================================
function initThemeSwitcher() {
  const savedTheme = localStorage.getItem("soil_air_theme") || "dark";
  applyAppTheme(savedTheme);

  const themeBtns = document.querySelectorAll(".btn-theme-select");
  themeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      themeBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const chosenTheme = btn.getAttribute("data-theme");
      applyAppTheme(chosenTheme);
    });
  });
}

function applyAppTheme(themeName) {
  localStorage.setItem("soil_air_theme", themeName);
  const badge = document.getElementById("badge-theme-mode");

  const themeBtns = document.querySelectorAll(".btn-theme-select");
  themeBtns.forEach(b => {
    if (b.getAttribute("data-theme") === themeName) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  });

  if (themeName === "light") {
    document.body.classList.add("theme-light");
    if (badge) badge.textContent = "Crisp White";
  } else if (themeName === "system") {
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    if (prefersLight) {
      document.body.classList.add("theme-light");
      if (badge) badge.textContent = "System (Light)";
    } else {
      document.body.classList.remove("theme-light");
      if (badge) badge.textContent = "System (Dark)";
    }
  } else {
    document.body.classList.remove("theme-light");
    if (badge) badge.textContent = "Dark Theme";
  }
}
