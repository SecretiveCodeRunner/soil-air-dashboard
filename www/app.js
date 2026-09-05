// Dual Air & Soil Telemetry Studio Engine (v3.0 - Multi-Device, Bang-Bang Control & Max/Min Edition)

const FIREBASE_BASE_URL = "https://esp32-soil-and-air-default-rtdb.asia-southeast1.firebasedatabase.app/";
const FIREBASE_API_KEY = "AIzaSyD-E7fj6XtqIysg1MDztO2AfuaBV9an4fY";
const FIREBASE_USER_EMAIL = "apurbamaity227@gmail.com";
const FIREBASE_USER_PASSWORD = "Student@12er";

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
let activeRangeMode = "24h";
let isDemoActive = false;
let demoIntervalTimer = null;

// Registered Devices & Multi-Node State
let registeredDevices = [
  { id: "ESP32-SOIL-AIR-01", name: "ESP32 Main Suite", path: "SensorData/SoilAirSuite", type: "ESP32" },
  { id: "ESP32-GREENHOUSE-02", name: "Greenhouse Polyhouse Node", path: "SensorData/Greenhouse02", type: "ESP32" }
];
let activeDeviceId = "ESP32-SOIL-AIR-01";

// Platform Detection: Native Capacitor APK vs Web Dashboard
const isNativeApp = (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// ============================================================================
// DIGITAL SIGNAL PROCESSING (DSP) & DUAL-SENSOR FUSION ENGINE
// ============================================================================
function dspMedianFilter(arr, windowSize = 5) {
  const half = Math.floor(windowSize / 2);
  return arr.map((val, idx) => {
    if (val === null || isNaN(val)) return null;
    const start = Math.max(0, idx - half);
    const end = Math.min(arr.length, idx + half + 1);
    const slice = arr.slice(start, end).filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
    return slice.length > 0 ? slice[Math.floor(slice.length / 2)] : val;
  });
}

function dspCalibrateCapacitive(raw) {
  if (raw === null || isNaN(raw)) return null;
  const dry = 2040;
  const wet = 1080;
  if (raw >= dry) return 0;
  if (raw <= wet) return 100;
  const norm = (dry - raw) / (dry - wet);
  const curve = Math.pow(norm, 1.15) * 100;
  return Math.min(100, Math.max(0, curve));
}

function dspCalibrateResistive(raw) {
  if (raw === null || isNaN(raw)) return null;
  const dry = 3500;
  const wet = 1000;
  if (raw >= dry) return 0;
  if (raw <= wet) return 100;
  const norm = (dry - raw) / (dry - wet);
  return Math.min(100, Math.max(0, norm * 100));
}

function dspCompensateMoistureTemperature(moistPct, soilTempC, refTemp = 25.0) {
  if (moistPct === null || soilTempC === null || isNaN(moistPct) || isNaN(soilTempC)) return moistPct;
  const deltaT = soilTempC - refTemp;
  const compensated = moistPct - (0.35 * deltaT);
  return Math.min(100, Math.max(0, compensated));
}

function dspIirSmooth(arr, alpha = 0.25) {
  let lastVal = null;
  return arr.map(val => {
    if (val === null || isNaN(val)) return null;
    if (lastVal === null) {
      lastVal = val;
      return val;
    }
    lastVal = (alpha * val) + ((1 - alpha) * lastVal);
    return lastVal;
  });
}

function processMoistureDSP(records) {
  if (!records || records.length === 0) return [];
  
  const rawCapArray = records.map(r => r.CapMoisture_Raw ?? 2040);
  const rawResArray = records.map(r => r.ResMoisture_Raw ?? 3500);
  
  const medCap = dspMedianFilter(rawCapArray, 5);
  const medRes = dspMedianFilter(rawResArray, 5);

  let prevFused = null;
  const fusedSeries = medCap.map((capAdc, i) => {
    const resAdc = medRes[i];
    const soilT = records[i] ? (records[i].SoilTemp_C ?? 25.0) : 25.0;

    // 1. Plausibility & Hardware Limits
    const isCapValid = (capAdc >= 700 && capAdc <= 2300);
    const isResValid = (resAdc >= 400 && resAdc <= 3800);

    const capPct = isCapValid ? dspCalibrateCapacitive(capAdc) : null;
    const resPct = isResValid ? dspCalibrateResistive(resAdc) : null;

    // 2. Glitch Detection & Confidence Weighting
    let wCap = isCapValid ? 0.80 : 0.0;
    let wRes = isResValid ? 0.20 : 0.0;

    // If capacitive jumps by >25% instantaneously, shift confidence to resistive
    if (prevFused !== null && isCapValid && capPct !== null) {
      if (Math.abs(capPct - prevFused) > 25.0 && isResValid) {
        wCap = 0.15;
        wRes = 0.85;
      }
    }

    const totalWeight = wCap + wRes;
    let fused = 50.0;
    if (totalWeight > 0) {
      fused = ((capPct ?? 50) * wCap + (resPct ?? 50) * wRes) / totalWeight;
    } else {
      fused = prevFused ?? 50.0;
    }

    // 3. Thermal Dielectric Compensation
    const compensated = dspCompensateMoistureTemperature(fused, soilT, 25.0);
    prevFused = compensated;
    return compensated;
  });

  return dspIirSmooth(fusedSeries, 0.25);
}

function calculateVPD(airTempC, airHumPct) {
  if (airTempC === null || airHumPct === null || isNaN(airTempC) || isNaN(airHumPct)) return null;
  const vpSat = 0.61078 * Math.exp((17.27 * airTempC) / (airTempC + 237.3));
  const vpAct = vpSat * (airHumPct / 100);
  return Math.max(0, vpSat - vpAct);
}

function calculateDewPoint(tempC, humPct) {
  if (tempC === null || humPct === null || isNaN(tempC) || isNaN(humPct) || humPct <= 0) return null;
  const a = 17.27;
  const b = 237.7;
  const alpha = ((a * tempC) / (b + tempC)) + Math.log(humPct / 100);
  return (b * alpha) / (a - alpha);
}

// Operational Chart Instances
let temperatureChart = null;
let humidityChart = null;
let soilMoistureChart = null;
let pressureChart = null;

// Research & Analytics Lab Chart Instances
let thermalHysteresisChart = null;
let capillaryDynamicsChart = null;
let dewPointRiskChart = null;
let salinityDiscrepancyChart = null;
let vpdWaveformChart = null;

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
  try { initLenisSmoothScroll(); } catch(e) { console.error("Lenis init error:", e); }
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
// LENIS PHYSICS-BASED SMOOTH SCROLLING ENGINE
// ============================================================================
let appLenis = null;

function initLenisSmoothScroll() {
  if (typeof Lenis === "undefined") {
    console.info("Lenis smooth scroll engine not loaded, using native browser scroll.");
    return;
  }

  // Configure Lenis with Apple-style smooth exponential deceleration
  appLenis = new Lenis({
    autoRaf: true,
    duration: 1.15,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    touchMultiplier: 1.25,
    infinite: false,
  });

  window.appLenis = appLenis;
}

// ============================================================================
// NATIVE BOTTOM NAVIGATION
// ============================================================================
function initNavigation() {
  if (!isNativeApp) {
    document.body.classList.add("platform-web");
    // Strict isolation: Manual Actuator & Relay Overrides and Admin Settings are strictly mobile APK features
    const forbiddenNav = document.querySelectorAll(".nav-control-tab, .nav-settings-tab");
    forbiddenNav.forEach(el => el.remove());
    const viewControl = document.getElementById("view-control");
    const viewSettings = document.getElementById("view-settings");
    if (viewControl) viewControl.remove();
    if (viewSettings) viewSettings.remove();
  } else {
    document.body.classList.add("platform-app");
  }

  const items = document.querySelectorAll(".nav-item");
  const panels = document.querySelectorAll(".view-panel");

  items.forEach(item => {
    item.addEventListener("click", () => {
      const targetId = item.getAttribute("data-target");
      if (!targetId) return;
      if (!isNativeApp && (targetId === "view-control" || targetId === "view-settings")) return;
      
      items.forEach(nav => {
        if (nav.getAttribute("data-target") === targetId) {
          nav.classList.add("active");
        } else {
          nav.classList.remove("active");
        }
      });
      panels.forEach(p => p.classList.remove("active"));

      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add("active");
        if (window.appLenis) {
          window.appLenis.scrollTo(0, { immediate: false });
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
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

  elTimeRangeSelect.addEventListener("change", async (e) => {
    activeRangeMode = e.target.value;
    if (activeRangeMode === "custom") {
      elCustomDateContainer.classList.remove("hidden");
    } else {
      elCustomDateContainer.classList.add("hidden");
      if (typeof fetchHistoricalTimeline === "function") {
        await fetchHistoricalTimeline(activeRangeMode);
      }
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
    summaryText = `Realtime stream (Last 15 Min • ${rawTelemetryHistory.length} points)`;
  } else if (activeRangeMode === "1h") {
    cutoffMs = now - (1 * 60 * 60 * 1000);
    summaryText = `Last 1 hour timeline (${rawTelemetryHistory.length} points)`;
  } else if (activeRangeMode === "24h") {
    cutoffMs = now - (24 * 60 * 60 * 1000);
    summaryText = `Last 24 hours timeline (${rawTelemetryHistory.length} sampled points)`;
  } else if (activeRangeMode === "3d") {
    cutoffMs = now - (3 * 24 * 60 * 60 * 1000);
    summaryText = `Last 3 days timeline (${rawTelemetryHistory.length} sampled points)`;
  } else if (activeRangeMode === "7d") {
    cutoffMs = now - (7 * 24 * 60 * 60 * 1000);
    summaryText = `Last 7 days timeline (${rawTelemetryHistory.length} sampled points)`;
  } else if (activeRangeMode === "all") {
    cutoffMs = 0;
    summaryText = `Full history timeline (${rawTelemetryHistory.length} sampled points)`;
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

  filteredHistory = [...rawTelemetryHistory];

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
    if (elDiagSdBadge) {
      elDiagSdBadge.textContent = isEspActive ? "ONLINE (FAT32 OK)" : "OFFLINE (Last: OK)";
      elDiagSdBadge.className = "badge badge-optimal";
    }
  } else {
    elSdStatus.textContent = isEspActive ? `ERR (${statusMsg})` : `OFFLINE (Last: ${statusMsg})`;
    elSdStatus.style.color = "#f87171";
    if (elSdIcon) elSdIcon.className = "fa-solid fa-triangle-exclamation color-temp";
    if (elDiagSdBadge) {
      elDiagSdBadge.textContent = isEspActive ? `ERR: ${statusMsg}` : `OFFLINE (Last: ${statusMsg})`;
      elDiagSdBadge.className = "badge badge-err";
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

  const isLight = document.body.classList.contains("theme-light");
  const gridColor = isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.04)";
  const tickColor = isLight ? "#6e6e73" : "#64748b";
  const legendColor = isLight ? "#1d1d1f" : "#cbd5e1";

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    spanGaps: false, // Breaks line graph during real power-off gaps
    animation: { duration: 250 },
    elements: {
      point: {
        radius: 0,
        hoverRadius: 5,
        hitRadius: 10
      },
      line: {
        tension: 0.35,
        borderCapStyle: 'round',
        borderJoinStyle: 'round'
      }
    },
    scales: {
      x: {
        grid: { color: gridColor },
        ticks: { color: tickColor, font: { family: "JetBrains Mono", size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
      },
      y: {
        grid: { color: gridColor },
        ticks: { color: isLight ? "#6e6e73" : "#94a3b8", font: { family: "JetBrains Mono", size: 11 } }
      }
    },
    plugins: {
      legend: { labels: { color: legendColor, font: { family: "Outfit", size: 11 } } }
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
              tension: 0.35,
              borderWidth: 2.2,
              pointRadius: 0,
              pointHoverRadius: 5,
              data: []
            },
            {
              label: "AHT20 Air (°C)",
              borderColor: "#38ef7d",
              backgroundColor: "rgba(56, 239, 125, 0.08)",
              fill: false,
              tension: 0.35,
              borderWidth: 2.2,
              pointRadius: 0,
              pointHoverRadius: 5,
              data: []
            },
            {
              label: "DS18B20 Soil (°C)",
              borderColor: "#ff9966",
              backgroundColor: "transparent",
              borderDash: [5, 5],
              tension: 0.35,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 5,
              data: []
            }
          ]
        },
        options: chartOptions
      });
    }

    // 2. Humidity Comparison
    const elHumCanvas = document.getElementById("humidityChart");
    if (elHumCanvas) {
      const ctxHum = elHumCanvas.getContext("2d");
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
              tension: 0.35,
              borderWidth: 2.2,
              pointRadius: 0,
              pointHoverRadius: 5,
              data: []
            },
            {
              label: "AHT20 Humidity (%)",
              borderColor: "#38ef7d",
              backgroundColor: "rgba(56, 239, 125, 0.08)",
              fill: true,
              tension: 0.35,
              borderWidth: 2.2,
              pointRadius: 0,
              pointHoverRadius: 5,
              data: []
            }
          ]
        },
        options: chartOptions
      });
    }

    // 3. Soil Moisture Comparison
    const elSoilCanvas = document.getElementById("soilMoistureChart");
    if (elSoilCanvas) {
      const ctxSoil = elSoilCanvas.getContext("2d");
      const soilDatasets = [
        {
          label: "Capacitive Soil Moisture (%)",
          borderColor: "#00f2fe",
          backgroundColor: "rgba(0, 242, 254, 0.12)",
          fill: false,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          data: []
        },
        {
          label: "Resistive Soil Moisture (%)",
          borderColor: "#4facfe",
          backgroundColor: "transparent",
          fill: false,
          tension: 0.35,
          borderWidth: 1.8,
          borderDash: [4, 4],
          pointRadius: 0,
          pointHoverRadius: 5,
          data: []
        }
      ];

      // Add DSP Filtered Realization Dataset on Website for Comparative Testing
      if (!isNativeApp) {
        soilDatasets.push({
          label: "DSP Filtered & Temp-Compensated (%)",
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.15)",
          fill: true,
          tension: 0.35,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 6,
          data: []
        });
      }

      soilMoistureChart = new Chart(ctxSoil, {
        type: "line",
        data: {
          labels: [],
          datasets: soilDatasets
        },
        options: chartOptions
      });
    }

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
              tension: 0.35,
              borderWidth: 2.2,
              pointRadius: 0,
              pointHoverRadius: 5,
              data: []
            }
          ]
        },
        options: chartOptions
      });
    }

    // ========================================================================
    // RESEARCH & ANALYTICS LAB CHARTS (WEB DASHBOARD)
    // ========================================================================
    if (!isNativeApp) {
      // 1. Soil Thermal Hysteresis Phase Portrait
      const elHystCanvas = document.getElementById("thermalHysteresisChart");
      if (elHystCanvas) {
        const ctxHyst = elHystCanvas.getContext("2d");
        thermalHysteresisChart = new Chart(ctxHyst, {
          type: "scatter",
          data: {
            datasets: [{
              label: "Diurnal Hysteresis Loop (T_soil vs T_air)",
              data: [],
              borderColor: "#00f2fe",
              backgroundColor: "rgba(0, 242, 254, 0.2)",
              showLine: true,
              tension: 0.25,
              borderWidth: 2,
              pointRadius: 2,
              pointHoverRadius: 6
            }]
          },
          options: {
            ...chartOptions,
            plugins: {
              ...chartOptions.plugins,
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    const p = ctx.raw;
                    return [
                      `Timestamp: ${p.label || 'N/A'}`,
                      `Air Temp: ${p.x}°C | Soil Temp: ${p.y}°C`,
                      `Gradient: ${(p.x - p.y >= 0 ? '+' : '')}${(p.x - p.y).toFixed(2)}°C (${p.x >= p.y ? 'Air Warmer' : 'Soil Warmer (Direct Sun)'})`
                    ];
                  }
                }
              }
            },
            scales: {
              x: {
                title: { display: true, text: "Air Temperature (°C)", color: "#8a99ad", font: { size: 11, weight: 'bold' } },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8a99ad" }
              },
              y: {
                title: { display: true, text: "Soil Temperature (°C)", color: "#8a99ad", font: { size: 11, weight: 'bold' } },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8a99ad" }
              }
            }
          }
        });
      }

      // 2. Capillary Recharge vs Evapotranspiration Rate
      const elCapDynCanvas = document.getElementById("capillaryDynamicsChart");
      if (elCapDynCanvas) {
        const ctxCapDyn = elCapDynCanvas.getContext("2d");
        capillaryDynamicsChart = new Chart(ctxCapDyn, {
          type: "bar",
          data: {
            labels: [],
            datasets: [{
              label: "Moisture Dynamics dθ/dt (%/hr)",
              data: [],
              backgroundColor: [],
              borderRadius: 3
            }]
          },
          options: {
            ...chartOptions,
            scales: {
              x: { grid: { display: false }, ticks: { color: "#8a99ad" } },
              y: {
                title: { display: true, text: "dθ/dt (% / Hour)", color: "#8a99ad", font: { size: 11, weight: 'bold' } },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8a99ad" }
              }
            }
          }
        });
      }

      // 3. Dew Point & Condensation / Fungal Risk Margin
      const elDewCanvas = document.getElementById("dewPointRiskChart");
      if (elDewCanvas) {
        const ctxDew = elDewCanvas.getContext("2d");
        dewPointRiskChart = new Chart(ctxDew, {
          type: "line",
          data: {
            labels: [],
            datasets: [
              {
                label: "Condensation Margin ΔT_dew (°C)",
                data: [],
                borderColor: "#38ef7d",
                backgroundColor: "rgba(56, 239, 125, 0.12)",
                fill: true,
                tension: 0.35,
                borderWidth: 2.2,
                pointRadius: 0
              },
              {
                label: "Critical Condensation Limit (1.5°C)",
                data: [],
                borderColor: "#ef4444",
                borderDash: [5, 5],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false
              }
            ]
          },
          options: {
            ...chartOptions,
            scales: {
              x: { grid: { display: false }, ticks: { color: "#8a99ad" } },
              y: {
                title: { display: true, text: "Margin to Dew Point (°C)", color: "#8a99ad", font: { size: 11, weight: 'bold' } },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8a99ad" }
              }
            }
          }
        });
      }

      // 4. Dual Sensor Discrepancy & Salinity Index
      const elSalCanvas = document.getElementById("salinityDiscrepancyChart");
      if (elSalCanvas) {
        const ctxSal = elSalCanvas.getContext("2d");
        salinityDiscrepancyChart = new Chart(ctxSal, {
          type: "line",
          data: {
            labels: [],
            datasets: [{
              label: "Discrepancy (Cap% - Res%)",
              data: [],
              borderColor: "#f59e0b",
              backgroundColor: "rgba(245, 158, 11, 0.12)",
              fill: true,
              tension: 0.35,
              borderWidth: 2,
              pointRadius: 0
            }]
          },
          options: {
            ...chartOptions,
            scales: {
              x: { grid: { display: false }, ticks: { color: "#8a99ad" } },
              y: {
                title: { display: true, text: "Capacitive - Resistive Offset (%)", color: "#8a99ad", font: { size: 11, weight: 'bold' } },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8a99ad" }
              }
            }
          }
        });
      }

      // 5. Vapor Pressure Deficit (VPD) Waveform
      const elVpdCanvas = document.getElementById("vpdWaveformChart");
      if (elVpdCanvas) {
        const ctxVpd = elVpdCanvas.getContext("2d");
        vpdWaveformChart = new Chart(ctxVpd, {
          type: "line",
          data: {
            labels: [],
            datasets: [
              {
                label: "Atmospheric Vapor Pressure Deficit (kPa)",
                data: [],
                borderColor: "#ec4899",
                backgroundColor: "rgba(236, 72, 153, 0.15)",
                fill: true,
                tension: 0.35,
                borderWidth: 2.2,
                pointRadius: 0
              }
            ]
          },
          options: {
            ...chartOptions,
            scales: {
              x: { grid: { display: false }, ticks: { color: "#8a99ad" } },
              y: {
                title: { display: true, text: "VPD (kPa)", color: "#8a99ad", font: { size: 11, weight: 'bold' } },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8a99ad" }
              }
            }
          }
        });
      }
    }
  } catch (err) {
    console.error("Error initializing Chart.js waveforms:", err);
  }
}

// ============================================================================
// ULTRA-LOW-BANDWIDTH FIREBASE STREAMING ENGINE
// ============================================================================
let firebasePollingTimer = null;
let lastKnownLiveTimestamp = null;

function getActiveDeviceBasePath() {
  const cur = (typeof registeredDevices !== 'undefined') ? (registeredDevices.find(d => d.id === activeDeviceId) || registeredDevices[0]) : null;
  let p = cur ? cur.path : "SensorData/SoilAirSuite";
  if (p.endsWith(".json")) p = p.substring(0, p.length - 5);
  return p;
}

// Cache shallow keys for responsive timeline switching without re-downloading key index
let cachedShallowKeys = null;
let lastShallowFetchTime = 0;

async function getShallowHistoryKeys(basePath) {
  const now = Date.now();
  if (cachedShallowKeys && (now - lastShallowFetchTime < 45000)) {
    return cachedShallowKeys;
  }

  const token = await getFirebaseIdToken();
  const authQuery = token ? `?auth=${token}&shallow=true` : '?shallow=true';
  const shallowUrl = `${FIREBASE_BASE_URL}${basePath}/History.json${authQuery}`;

  try {
    const res = await fetch(shallowUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        cachedShallowKeys = Object.keys(data).sort();
        lastShallowFetchTime = now;
        return cachedShallowKeys;
      }
    }
  } catch (e) {
    console.warn("Error fetching shallow keys:", e);
  }
  return cachedShallowKeys || [];
}

// 1. Dynamic Historical Timeline Fetcher (Samples timeline to ~300 high-resolution points)
async function fetchHistoricalTimeline(rangeMode = "24h") {
  if (isDemoActive) return;
  const basePath = getActiveDeviceBasePath();

  try {
    const allKeys = await getShallowHistoryKeys(basePath);
    if (!allKeys || allKeys.length === 0) return;

    let targetKeys = [];
    const totalKeys = allKeys.length;

    if (rangeMode === "15m") {
      targetKeys = allKeys.slice(-90);
    } else if (rangeMode === "1h") {
      targetKeys = allKeys.slice(-240);
    } else if (rangeMode === "24h") {
      const last24h = allKeys.slice(-8640);
      const step = Math.max(1, Math.floor(last24h.length / 300));
      for (let i = 0; i < last24h.length; i += step) targetKeys.push(last24h[i]);
      if (targetKeys[targetKeys.length - 1] !== last24h[last24h.length - 1]) targetKeys.push(last24h[last24h.length - 1]);
    } else if (rangeMode === "3d") {
      const last3d = allKeys.slice(-25920);
      const step = Math.max(1, Math.floor(last3d.length / 400));
      for (let i = 0; i < last3d.length; i += step) targetKeys.push(last3d[i]);
      if (targetKeys[targetKeys.length - 1] !== last3d[last3d.length - 1]) targetKeys.push(last3d[last3d.length - 1]);
    } else if (rangeMode === "7d") {
      const last7d = allKeys.slice(-60480);
      const step = Math.max(1, Math.floor(last7d.length / 400));
      for (let i = 0; i < last7d.length; i += step) targetKeys.push(last7d[i]);
      if (targetKeys[targetKeys.length - 1] !== last7d[last7d.length - 1]) targetKeys.push(last7d[last7d.length - 1]);
    } else if (rangeMode === "all") {
      const step = Math.max(1, Math.floor(totalKeys / 500));
      for (let i = 0; i < totalKeys; i += step) targetKeys.push(allKeys[i]);
      if (targetKeys[targetKeys.length - 1] !== allKeys[totalKeys - 1]) targetKeys.push(allKeys[totalKeys - 1]);
    } else {
      targetKeys = allKeys.slice(-120);
    }

    const token = await getFirebaseIdToken();
    const authQuery = token ? `?auth=${token}` : '';

    const pointPromises = targetKeys.map(async k => {
      try {
        const r = await fetch(`${FIREBASE_BASE_URL}${basePath}/History/${k}.json${authQuery}`);
        return r.ok ? await r.json() : null;
      } catch (e) {
        return null;
      }
    });

    const results = await Promise.all(pointPromises);
    const validPoints = results.filter(p => p && (p.Time || p.Timestamp));

    if (validPoints.length > 0) {
      rawTelemetryHistory = validPoints;
      try {
        localStorage.setItem(`soil_air_cache_${activeDeviceId}`, JSON.stringify(rawTelemetryHistory.slice(-300)));
      } catch (e) {}
      applyTimeFilter();
    }
  } catch (err) {
    console.warn("fetchHistoricalTimeline error:", err);
  }
}

// Initial historical load uses the active time range (default 24h)
async function fetchInitialHistory() {
  await fetchHistoricalTimeline(activeRangeMode || "24h");
}


// 2. High-Frequency Live Poller (Polls ONLY /Live.json -> ~300 bytes per request)
async function fetchTelemetryData() {
  if (isDemoActive) return;

  const basePath = getActiveDeviceBasePath();
  try {
    const token = firebaseIdToken || (await getFirebaseIdToken());
    const authParam = token ? `?auth=${token}` : '';
    const liveUrl = `${FIREBASE_BASE_URL}${basePath}/Live.json${authParam}`;

    let res = await fetch(liveUrl);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        const newToken = await getFirebaseIdToken();
        if (newToken) {
          res = await fetch(`${FIREBASE_BASE_URL}${basePath}/Live.json?auth=${newToken}`);
        }
      }
    }

    if (res && res.ok) {
      const livePoint = await res.json();
      if (livePoint && !livePoint.error && typeof livePoint === 'object') {
        processLiveReading(livePoint);
        return;
      }
    }

    if (rawTelemetryHistory.length > 0) {
      applyTimeFilter();
    } else {
      setConnectionState("offline", "Offline • Cloud Data Unavailable");
    }
  } catch (err) {
    console.warn("Live telemetry fetch error:", err);
    if (rawTelemetryHistory.length > 0) {
      applyTimeFilter();
    } else {
      setConnectionState("offline", "Offline • Network Connection Timeout");
    }
  }
}

// 3. Process Live Reading and Append
function processLiveReading(liveRec) {
  if (!liveRec || typeof liveRec !== 'object') return;

  if (!liveRec.Date || liveRec.Date.startsWith("2000") || liveRec.Date.startsWith("1970")) {
    liveRec._rawTime = liveRec.Time;
    liveRec._unsyncedRtc = true;
  }

  const pointTimestamp = liveRec.Timestamp || liveRec.Time || new Date().toISOString();

  // Update SD Health badge if provided
  if (liveRec.SD_Card_Status) {
    const isEspActive = (lastRecordReceivedTime > 0) && (Date.now() - lastRecordReceivedTime < 45000);
    updateSdHealthBadge(liveRec.SD_Card_Status, isEspActive);
  }

  // Append or update in rawTelemetryHistory
  const lastIndex = rawTelemetryHistory.length - 1;
  const lastPoint = lastIndex >= 0 ? rawTelemetryHistory[lastIndex] : null;
  const lastStamp = lastPoint ? (lastPoint.Timestamp || lastPoint.Time) : null;

  if (!lastPoint || lastStamp !== pointTimestamp) {
    rawTelemetryHistory.push(liveRec);
    if (rawTelemetryHistory.length > 300) {
      rawTelemetryHistory.shift();
    }
    lastKnownLiveTimestamp = pointTimestamp;
  } else {
    rawTelemetryHistory[lastIndex] = liveRec;
  }

  try {
    localStorage.setItem(`soil_air_cache_${activeDeviceId}`, JSON.stringify(rawTelemetryHistory.slice(-200)));
  } catch (e) {}

  const elStatusBox = document.getElementById("active-device-status-box");
  if (elStatusBox) {
    elStatusBox.innerHTML = `<span class="badge badge-optimal">ONLINE STREAM</span>`;
  }

  applyTimeFilter();
}

async function startFirebasePolling() {
  if (firebasePollingTimer) clearInterval(firebasePollingTimer);

  // A. Fire live poll & actuator sync IMMEDIATELY (instant ESP32 status in ~100ms)
  fetchTelemetryData();
  fetchActuatorNodeStatus();

  // B. Fetch historical timeline in background without blocking live poller
  fetchInitialHistory();

  // C. Polling interval: live is only ~300 bytes
  let pollInterval = 3500;
  firebasePollingTimer = setInterval(async () => {
    if (document.hidden) return;
    await fetchTelemetryData();
  }, pollInterval);

  // Actuator status polling every 10s
  setInterval(() => {
    if (!document.hidden) fetchActuatorNodeStatus();
  }, 10000);

  // Immediate poll when tab becomes active again
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      fetchTelemetryData();
      fetchActuatorNodeStatus();
    }
  });
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

  // On Web Platform: Update VPD & DSP Filtered Moisture Cards
  if (!isNativeApp) {
    const airT = (bmeTemp !== undefined && bmeTemp !== null) ? bmeTemp : (ahtTemp ?? 25.0);
    const airH = (bmeHum !== undefined && bmeHum !== null) ? bmeHum : (ahtHum ?? 50.0);
    const vpd = calculateVPD(airT, airH);
    const elVpd = document.getElementById("val-vpd");
    const elBadgeVpd = document.getElementById("badge-vpd");
    if (elVpd && vpd !== null) elVpd.innerHTML = `${formatNum(vpd, 2)} <span class="unit">kPa</span>`;
    if (elBadgeVpd && vpd !== null) {
      if (vpd < 0.4) {
        elBadgeVpd.textContent = "Low Transp.";
        elBadgeVpd.className = "badge badge-warning";
      } else if (vpd > 1.6) {
        elBadgeVpd.textContent = "High Stress";
        elBadgeVpd.className = "badge badge-danger";
      } else {
        elBadgeVpd.textContent = "Optimal";
        elBadgeVpd.className = "badge badge-optimal";
      }
    }

    const latestCapRaw = latest.CapMoisture_Raw ?? 2040;
    const latestResRaw = latest.ResMoisture_Raw ?? 3500;
    const latestSoilT = latest.SoilTemp_C ?? 25.0;

    const isCapValid = (latestCapRaw >= 700 && latestCapRaw <= 2300);
    const isResValid = (latestResRaw >= 400 && latestResRaw <= 3800);
    const capPct = isCapValid ? dspCalibrateCapacitive(latestCapRaw) : null;
    const resPct = isResValid ? dspCalibrateResistive(latestResRaw) : null;
    const wCap = isCapValid ? 0.80 : 0.0;
    const wRes = isResValid ? 0.20 : 0.0;
    const totalW = wCap + wRes;
    const rawFused = totalW > 0 ? (((capPct ?? 50) * wCap + (resPct ?? 50) * wRes) / totalW) : 50.0;
    const dspComp = dspCompensateMoistureTemperature(rawFused, latestSoilT, 25.0);

    const elDspMoist = document.getElementById("val-dsp-moist");
    if (elDspMoist && dspComp !== null) elDspMoist.innerHTML = `${formatNum(dspComp, 0)} <span class="unit">%</span>`;
  }

  // Compute & Display Maximum and Minimum Stats for current window
  updateMetricsStats(displayHistory);

  // Evaluate Bang-Bang Controller Logic
  evaluateBangBangController(latest);

  updateCharts(displayHistory);
  if (!isNativeApp) {
    updateResearchLab(displayHistory);
  }
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

  if (!isNativeApp) {
    const vpdVals = records.map(r => {
      const t = r.BME_AirTemp_C ?? r.AHT_AirTemp_C ?? r.AirTemp_C;
      const h = r.BME_AirHumidity_Pct ?? r.AHT_AirHumidity_Pct ?? r.AirHumidity_Pct;
      return (t !== undefined && h !== undefined) ? calculateVPD(t, h) : null;
    }).filter(v => v !== null && !isNaN(v));

    if (vpdVals.length > 0) {
      setElText("max-vpd", Math.max(...vpdVals), 2);
      setElText("min-vpd", Math.min(...vpdVals), 2);
    }
  }
}

function updateCharts(records) {
  if (!records || records.length === 0) return;

  const maxChartPoints = 1200;
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

  // Calculate dynamic adaptive gap threshold based on the actual time span
  let firstMs = 0;
  let lastSampleMs = 0;
  for (let i = 0; i < sampledRecords.length; i++) {
    const t = parseRecordTimestampMs(sampledRecords[i]);
    if (t > 0) {
      if (firstMs === 0) firstMs = t;
      lastSampleMs = t;
    }
  }
  const totalSpanMs = Math.max(0, lastSampleMs - firstMs);
  const avgIntervalMs = sampledRecords.length > 1 ? (totalSpanMs / (sampledRecords.length - 1)) : 10000;
  // Adaptive gap threshold: only break curve if an outage is at least 3.5x the average interval and > 5 min
  const maxGapMs = Math.max(300000, avgIntervalMs * 3.5);

  const isMultiDay = totalSpanMs > (24 * 3600 * 1000);

  let prevMs = 0;

  sampledRecords.forEach((r) => {
    const currentMs = parseRecordTimestampMs(r);

    if (prevMs > 0 && currentMs > 0 && (currentMs - prevMs > maxGapMs)) {
      labels.push("GAP");
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
    if (isMultiDay && r.Date && r.Time) {
      const dateParts = r.Date.split("-");
      const shortDate = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : r.Date;
      const shortTime = r.Time.substring(0, 5);
      timeLabel = `${shortDate} ${shortTime}`;
    } else if (r.Time) {
      timeLabel = r.Time.substring(0, 5);
    } else if (r.Timestamp) {
      const parts = r.Timestamp.split("T");
      timeLabel = parts.length > 1 ? parts[1].replace("Z", "").substring(0, 5) : r.Timestamp;
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

    // On Web: Update 3rd DSP Filtered dataset
    if (!isNativeApp && soilMoistureChart.data.datasets.length > 2) {
      const dspMoistData = processMoistureDSP(sampledRecords);
      soilMoistureChart.data.datasets[2].data = dspMoistData;
    }

    soilMoistureChart.update();
  }

  if (pressureChart) {
    pressureChart.data.labels = labels;
    pressureChart.data.datasets[0].data = pressData;
    pressureChart.update();
  }
}

// ============================================================================
// RESEARCH & ANALYTICS LAB COMPUTATION ENGINE (WEB STUDIO)
// ============================================================================
function updateResearchLab(records) {
  if (!records || records.length === 0) return;

  const maxResearchPoints = 600;
  const step = Math.max(1, Math.floor(records.length / maxResearchPoints));
  const sampled = records.filter((_, idx) => idx % step === 0);

  const elBadge = document.getElementById("research-records-badge");
  if (elBadge) {
    elBadge.innerHTML = `<i class="fa-solid fa-database"></i> ${sampled.length} High-Fidelity Samples (${records.length} Total)`;
  }

  // 1. Soil Thermal Hysteresis Phase Loop (T_soil vs T_air)
  const hysteresisPoints = [];
  sampled.forEach(r => {
    const airT = r.BME_AirTemp_C ?? r.AHT_AirTemp_C ?? r.AirTemp_C;
    const soilT = r.SoilTemp_C;
    if (airT !== null && airT !== undefined && soilT !== null && soilT !== undefined) {
      let timeLabel = "";
      if (r.Date && r.Time) {
        const p = r.Date.split("-");
        timeLabel = p.length === 3 ? `${p[1]}/${p[2]} ${r.Time.substring(0, 5)}` : `${r.Date} ${r.Time.substring(0, 5)}`;
      } else if (r.Time) {
        timeLabel = r.Time.substring(0, 5);
      }
      hysteresisPoints.push({
        x: Number(Number(airT).toFixed(2)),
        y: Number(Number(soilT).toFixed(2)),
        label: timeLabel
      });
    }
  });

  if (thermalHysteresisChart) {
    thermalHysteresisChart.data.datasets[0].data = hysteresisPoints;
    thermalHysteresisChart.update();
  }

  // 2. Capillary Recharge vs Evapotranspiration Rate (dθ/dt in %/hr)
  const dynLabels = [];
  const rateData = [];
  const rateColors = [];

  // Use rolling central-difference derivative (5-point span) to eliminate single-sample integer jitter
  const radius = Math.min(2, Math.floor(sampled.length / 10));
  for (let i = radius; i < sampled.length - radius; i++) {
    const prev = sampled[i - radius];
    const next = sampled[i + radius];
    const curr = sampled[i];
    const tPrev = parseRecordTimestampMs(prev);
    const tNext = parseRecordTimestampMs(next);
    const mPrev = prev.CapMoisture_Pct ?? 50;
    const mNext = next.CapMoisture_Pct ?? 50;

    if (tNext > tPrev && (tNext - tPrev < 3600000 * 12)) {
      const dtHours = (tNext - tPrev) / 3600000;
      if (dtHours > 0.02) {
        let rate = (mNext - mPrev) / dtHours;
        rate = Math.max(-8, Math.min(8, rate)); // Clamp physical rates to +/- 8 %/hr

        let timeStr = "";
        if (curr.Date && curr.Time) {
          const p = curr.Date.split("-");
          timeStr = p.length === 3 ? `${p[1]}/${p[2]} ${curr.Time.substring(0, 5)}` : `${curr.Date} ${curr.Time.substring(0, 5)}`;
        } else if (curr.Time) {
          timeStr = curr.Time.substring(0, 5);
        }

        dynLabels.push(timeStr);
        rateData.push(Number(rate.toFixed(2)));
        // Green: Capillary Rise / Vapor Absorption (+), Amber: Solar Evaporative Drying (-)
        rateColors.push(rate >= 0 ? "rgba(16, 185, 129, 0.85)" : "rgba(245, 158, 11, 0.85)");
      }
    }
  }

  if (capillaryDynamicsChart) {
    capillaryDynamicsChart.data.labels = dynLabels;
    capillaryDynamicsChart.data.datasets[0].data = rateData;
    capillaryDynamicsChart.data.datasets[0].backgroundColor = rateColors;
    capillaryDynamicsChart.update();
  }

  // 3. Dew Point & Condensation / Fungal Risk Margin
  const dewLabels = [];
  const dewMarginData = [];
  const critLimitData = [];

  sampled.forEach(r => {
    const airT = r.BME_AirTemp_C ?? r.AHT_AirTemp_C ?? r.AirTemp_C;
    const airH = r.BME_AirHumidity_Pct ?? r.AHT_AirHumidity_Pct ?? r.AirHumidity_Pct;
    if (airT !== null && airT !== undefined && airH !== null && airH !== undefined) {
      const td = calculateDewPoint(airT, airH);
      if (td !== null) {
        const margin = Math.max(0, airT - td);
        let timeStr = "";
        if (r.Date && r.Time) {
          const p = r.Date.split("-");
          timeStr = p.length === 3 ? `${p[1]}/${p[2]} ${r.Time.substring(0, 5)}` : `${r.Date} ${r.Time.substring(0, 5)}`;
        } else if (r.Time) {
          timeStr = r.Time.substring(0, 5);
        }

        dewLabels.push(timeStr);
        dewMarginData.push(Number(margin.toFixed(2)));
        critLimitData.push(1.5);
      }
    }
  });

  if (dewPointRiskChart) {
    dewPointRiskChart.data.labels = dewLabels;
    dewPointRiskChart.data.datasets[0].data = dewMarginData;
    dewPointRiskChart.data.datasets[1].data = critLimitData;
    dewPointRiskChart.update();
  }

  // 4. Dual Sensor Discrepancy & Salinity Index
  const salLabels = [];
  const salDiffData = [];

  sampled.forEach(r => {
    const c = r.CapMoisture_Pct;
    const res = r.ResMoisture_Pct;
    if (c !== null && c !== undefined && res !== null && res !== undefined) {
      const diff = c - res;
      let timeStr = "";
      if (r.Date && r.Time) {
        const p = r.Date.split("-");
        timeStr = p.length === 3 ? `${p[1]}/${p[2]} ${r.Time.substring(0, 5)}` : `${r.Date} ${r.Time.substring(0, 5)}`;
      } else if (r.Time) {
        timeStr = r.Time.substring(0, 5);
      }
      salLabels.push(timeStr);
      salDiffData.push(Number(diff.toFixed(1)));
    }
  });

  if (salinityDiscrepancyChart) {
    salinityDiscrepancyChart.data.labels = salLabels;
    salinityDiscrepancyChart.data.datasets[0].data = salDiffData;
    salinityDiscrepancyChart.update();
  }

  // 5. Vapor Pressure Deficit (VPD) Waveform
  const vpdLabels = [];
  const vpdValues = [];

  sampled.forEach(r => {
    const airT = r.BME_AirTemp_C ?? r.AHT_AirTemp_C ?? r.AirTemp_C;
    const airH = r.BME_AirHumidity_Pct ?? r.AHT_AirHumidity_Pct ?? r.AirHumidity_Pct;
    if (airT !== null && airT !== undefined && airH !== null && airH !== undefined) {
      const vpd = calculateVPD(airT, airH);
      if (vpd !== null) {
        let timeStr = "";
        if (r.Date && r.Time) {
          const p = r.Date.split("-");
          timeStr = p.length === 3 ? `${p[1]}/${p[2]} ${r.Time.substring(0, 5)}` : `${r.Date} ${r.Time.substring(0, 5)}`;
        } else if (r.Time) {
          timeStr = r.Time.substring(0, 5);
        }
        vpdLabels.push(timeStr);
        vpdValues.push(Number(vpd.toFixed(2)));
      }
    }
  });

  if (vpdWaveformChart) {
    vpdWaveformChart.data.labels = vpdLabels;
    vpdWaveformChart.data.datasets[0].data = vpdValues;
    vpdWaveformChart.update();
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
// BANG-BANG HYSTERESIS CONTROLLER & ACTUATION MODULE
// ============================================================================
let bangBangConfig = {
  autoIrrigation: true,
  autoFan: true,
  moistOn: 35,
  moistOff: 55,
  tempOn: 32,
  tempOff: 28,
  humOn: 80,
  humOff: 68,
  capWeight: 0.7,
  resWeight: 0.3,
  relays: { 1: false, 2: false, 3: false, 4: false }
};

let lastManualRelayActionTime = 0;

function calculateCompositeMoisture(record) {
  if (!record) return { composite: 50, cap: "--", res: "--" };
  const cap = record.CapMoisture_Pct;
  const res = record.ResMoisture_Pct;

  const validCap = cap !== undefined && cap !== null && !isNaN(cap) && cap >= 0 && cap <= 100;
  const validRes = res !== undefined && res !== null && !isNaN(res) && res >= 0 && res <= 100;

  let composite = 50;
  if (validCap && validRes) {
    // Optimal Composite Formula: 70% Capacitive (stability) + 30% Resistive (rapid dynamic response)
    composite = Math.round((cap * bangBangConfig.capWeight) + (res * bangBangConfig.resWeight));
  } else if (validCap) {
    composite = Math.round(cap);
  } else if (validRes) {
    composite = Math.round(res);
  }

  return {
    composite: Math.min(100, Math.max(0, composite)),
    cap: validCap ? `${cap}%` : "--",
    res: validRes ? `${res}%` : "--"
  };
}

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

  const rngHumOn = document.getElementById("rng-hum-on");
  const dispHumOn = document.getElementById("disp-hum-on");

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

  if (rngHumOn) {
    rngHumOn.value = bangBangConfig.humOn || 80;
    if (dispHumOn) dispHumOn.textContent = `${bangBangConfig.humOn || 80}%`;
    rngHumOn.addEventListener("input", (e) => {
      bangBangConfig.humOn = parseInt(e.target.value, 10);
      if (dispHumOn) dispHumOn.textContent = `${bangBangConfig.humOn}%`;
      saveBangBangConfig();
    });
  }

  if (chkIrrigation) {
    chkIrrigation.checked = bangBangConfig.autoIrrigation;
    chkIrrigation.addEventListener("change", (e) => {
      bangBangConfig.autoIrrigation = e.target.checked;
      saveBangBangConfig();
      pushRelayStatesToFirebase();
    });
  }

  if (chkFan) {
    chkFan.checked = bangBangConfig.autoFan;
    chkFan.addEventListener("change", (e) => {
      bangBangConfig.autoFan = e.target.checked;
      saveBangBangConfig();
      pushRelayStatesToFirebase();
    });
  }

  // Individual Relay Card & Switch Click Handlers
  for (let rId = 1; rId <= 4; rId++) {
    const relayCard = document.getElementById(`relay-card-${rId}`);
    const toggleInput = document.getElementById(`toggle-relay-${rId}`);

    if (toggleInput) {
      toggleInput.addEventListener("change", (e) => {
        bangBangConfig.relays[rId] = e.target.checked;
        lastManualRelayActionTime = Date.now();

        if (rId === 1) {
          bangBangConfig.autoIrrigation = false;
          if (chkIrrigation) chkIrrigation.checked = false;
        } else if (rId === 2) {
          bangBangConfig.autoFan = false;
          if (chkFan) chkFan.checked = false;
        }

        saveBangBangConfig();
        updateRelaysUI();
        pushRelayStatesToFirebase(rId);
      });
    }

    if (relayCard) {
      relayCard.addEventListener("click", (e) => {
        if (e.target.tagName !== 'INPUT' && !e.target.closest('.switch-toggle')) {
          if (toggleInput) {
            toggleInput.checked = !toggleInput.checked;
            toggleInput.dispatchEvent(new Event('change'));
          }
        }
      });
    }
  }

  // Master ALL ON Button
  const btnMasterAllOn = document.getElementById("btn-master-all-on");
  if (btnMasterAllOn) {
    btnMasterAllOn.addEventListener("click", () => {
      lastManualRelayActionTime = Date.now();
      for (let i = 1; i <= 4; i++) {
        bangBangConfig.relays[i] = true;
      }
      bangBangConfig.autoIrrigation = false;
      bangBangConfig.autoFan = false;
      if (chkIrrigation) chkIrrigation.checked = false;
      if (chkFan) chkFan.checked = false;

      saveBangBangConfig();
      updateRelaysUI();
      pushRelayStatesToFirebase();
    });
  }

  // Master ALL OFF Button (Emergency / Safe Shutoff)
  const btnMasterAllOff = document.getElementById("btn-master-all-off");
  if (btnMasterAllOff) {
    btnMasterAllOff.addEventListener("click", () => {
      lastManualRelayActionTime = Date.now();
      for (let i = 1; i <= 4; i++) {
        bangBangConfig.relays[i] = false;
      }
      bangBangConfig.autoIrrigation = false;
      bangBangConfig.autoFan = false;
      if (chkIrrigation) chkIrrigation.checked = false;
      if (chkFan) chkFan.checked = false;

      saveBangBangConfig();
      updateRelaysUI();
      pushRelayStatesToFirebase();
    });
  }

  updateRelaysUI();
}

function saveBangBangConfig() {
  localStorage.setItem("soil_air_bang_bang", JSON.stringify(bangBangConfig));
}

function evaluateBangBangController(latestRecord) {
  if (!latestRecord) return;

  // 1. Compute Composite Soil Moisture (70% Cap + 30% Res)
  const moistData = calculateCompositeMoisture(latestRecord);
  const compositeMoist = moistData.composite;

  // Update UI Elements for Composite Moisture
  const elValComposite = document.getElementById("val-composite-moist");
  const elDispCap = document.getElementById("disp-cap-val");
  const elDispRes = document.getElementById("disp-res-val");
  if (elValComposite) elValComposite.textContent = `${compositeMoist}%`;
  if (elDispCap) elDispCap.textContent = `Cap ${moistData.cap} (70%)`;
  if (elDispRes) elDispRes.textContent = `Res ${moistData.res} (30%)`;

  // 2. Compute Mean Canopy Temperature & Humidity
  const temp = latestRecord.BME_AirTemp_C ?? latestRecord.AHT_AirTemp_C ?? latestRecord.AirTemp_C ?? 25;
  const hum = latestRecord.BME_AirHumidity_Pct ?? latestRecord.AHT_AirHumidity_Pct ?? latestRecord.AirHumidity_Pct ?? 60;

  const elValPump = document.getElementById("val-pump-relay");
  const elValFan = document.getElementById("val-fan-relay");

  // 3. Ground-Truth Hardware State Sync:
  // Protect recent user manual actions for 15 seconds
  const isRecentlyManuallyTriggered = (Date.now() - lastManualRelayActionTime < 15000);

  if (!isRecentlyManuallyTriggered) {
    if (latestRecord.Actuator_Pump !== undefined) {
      bangBangConfig.relays[1] = (latestRecord.Actuator_Pump === "ON");
    } else if (bangBangConfig.autoIrrigation) {
      if (compositeMoist <= bangBangConfig.moistOn) {
        bangBangConfig.relays[1] = true;
      } else if (compositeMoist >= bangBangConfig.moistOff) {
        bangBangConfig.relays[1] = false;
      }
    }

    // 4. Ventilation & Cooling Fan State Sync
    if (latestRecord.Actuator_Fan !== undefined) {
      bangBangConfig.relays[2] = (latestRecord.Actuator_Fan === "ON");
    } else if (bangBangConfig.autoFan) {
      const humThresholdOn = bangBangConfig.humOn || 80;
      const humThresholdOff = bangBangConfig.humOff || 68;
      if (temp >= bangBangConfig.tempOn || hum >= humThresholdOn) {
        bangBangConfig.relays[2] = true;
      } else if (temp <= bangBangConfig.tempOff && hum <= humThresholdOff) {
        bangBangConfig.relays[2] = false;
      }
    }
  }

  if (elValPump) {
    const isPumpOn = bangBangConfig.relays[1];
    elValPump.textContent = isPumpOn ? "ON (Motor / Pump Active)" : "OFF (Motor Idle)";
    elValPump.className = isPumpOn ? "state-on" : "state-off";
  }

  if (elValFan) {
    const isFanOn = bangBangConfig.relays[2];
    const isHot = temp >= bangBangConfig.tempOn;
    const isHumid = hum >= (bangBangConfig.humOn || 80);
    let reason = "Active";
    if (isHot && isHumid) reason = "Thermal + Humid Active";
    else if (isHot) reason = "Thermal Cooling Active";
    else if (isHumid) reason = "Dehumidification Active";

    elValFan.textContent = isFanOn ? `ON (${reason})` : "OFF (Temp & Hum Normal)";
    elValFan.className = isFanOn ? "state-on" : "state-off";
  }

  updateRelaysUI();
}

function updateRelaysUI() {
  for (let i = 1; i <= 4; i++) {
    const card = document.getElementById(`relay-card-${i}`);
    const toggleInput = document.getElementById(`toggle-relay-${i}`);
    const statusPill = document.getElementById(`relay-status-${i}`);
    const isRelayActive = !!bangBangConfig.relays[i];

    if (card) {
      if (isRelayActive) {
        card.classList.add("active-relay");
      } else {
        card.classList.remove("active-relay");
      }
    }
    if (toggleInput) {
      toggleInput.checked = isRelayActive;
    }
    if (statusPill) {
      statusPill.textContent = isRelayActive ? "ACTIVE" : "OFF";
      statusPill.className = `relay-status-pill ${isRelayActive ? 'status-on' : 'status-off'}`;
    }
  }

  // Update header mode banner
  const elCtrlStatus = document.getElementById("ctrl-mode-status");
  if (elCtrlStatus) {
    const isAuto = bangBangConfig.autoIrrigation && bangBangConfig.autoFan;
    if (isAuto) {
      elCtrlStatus.innerHTML = '<span class="pulse-dot"></span> AUTO BANG-BANG ACTIVE';
      elCtrlStatus.className = 'ctrl-status-badge active';
    } else {
      elCtrlStatus.innerHTML = '<span class="pulse-dot" style="background: #ff9f0a; box-shadow: 0 0 8px #ff9f0a;"></span> MANUAL OVERRIDE ACTIVE';
      elCtrlStatus.className = 'ctrl-status-badge manual';
    }
  }
}

async function pushRelayStatesToFirebase(targetRelayId = null) {
  try {
    const token = await getFirebaseIdToken();
    const authParam = token ? `?auth=${token}` : '';

    const modeStr = (bangBangConfig.autoIrrigation || bangBangConfig.autoFan) ? "AUTO" : "MANUAL";

    // A. Update legacy Relays mapping
    const relaysUrl = `${FIREBASE_BASE_URL}Control/Relays.json${authParam}`;
    fetch(relaysUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bangBangConfig.relays)
    }).catch(() => {});

    // B. Push structured /Control payload
    const controlPayload = {
      Mode: modeStr,
      Pump: {
        State: bangBangConfig.relays[1] ? "ON" : "OFF",
        TriggerSource: bangBangConfig.autoIrrigation ? "AUTO_COMPOSITE_MOISTURE" : "APP_MANUAL_OVERRIDE",
        DryThreshold_Pct: bangBangConfig.moistOn,
        WetThreshold_Pct: bangBangConfig.moistOff,
        LastUpdated: new Date().toISOString()
      },
      Fan: {
        State: bangBangConfig.relays[2] ? "ON" : "OFF",
        TriggerSource: bangBangConfig.autoFan ? "AUTO_TEMP_HUM" : "APP_MANUAL_OVERRIDE",
        HighTempThreshold_C: bangBangConfig.tempOn,
        HighHumThreshold_Pct: bangBangConfig.humOn || 80,
        LastUpdated: new Date().toISOString()
      },
      Relay3: {
        State: bangBangConfig.relays[3] ? "ON" : "OFF",
        TriggerSource: "APP_MANUAL_OVERRIDE",
        LastUpdated: new Date().toISOString()
      },
      Relay4: {
        State: bangBangConfig.relays[4] ? "ON" : "OFF",
        TriggerSource: "APP_MANUAL_OVERRIDE",
        LastUpdated: new Date().toISOString()
      }
    };

    const ctrlUrl = `${FIREBASE_BASE_URL}Control.json${authParam}`;
    await fetch(ctrlUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(controlPayload)
    });

    // C. Direct fast path for individual state
    if (targetRelayId === 1 || targetRelayId === null) {
      const pumpUrl = `${FIREBASE_BASE_URL}Control/Pump/State.json${authParam}`;
      fetch(pumpUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bangBangConfig.relays[1] ? "ON" : "OFF")
      }).catch(() => {});
    }

    if (targetRelayId === 2 || targetRelayId === null) {
      const fanUrl = `${FIREBASE_BASE_URL}Control/Fan/State.json${authParam}`;
      fetch(fanUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bangBangConfig.relays[2] ? "ON" : "OFF")
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("Relay push to Firebase error:", e);
  }
}

async function fetchActuatorNodeStatus() {
  try {
    const token = await getFirebaseIdToken();
    const url = `${FIREBASE_BASE_URL}ActuatorNode.json${token ? `?auth=${token}` : ''}`;
    const res = await fetch(url);
    if (res.ok) {
      const node = await res.json();
      if (node && node.Status) {
        const elStatus = document.getElementById("val-actuator-node-status");
        const pillPump = document.getElementById("pill-actuator-pump");
        const pillFan = document.getElementById("pill-actuator-fan");

        const isPumpOn = node.PhysicalPumpRelay === "ON";
        const isFanOn = node.PhysicalFanRelay === "ON";

        const isRecentlyManuallyTriggered = (Date.now() - lastManualRelayActionTime < 15000);
        if (!isRecentlyManuallyTriggered) {
          bangBangConfig.relays[1] = isPumpOn;
          bangBangConfig.relays[2] = isFanOn;
          updateRelaysUI();
        }

        if (elStatus) {
          const rssi = node.WiFi_RSSI ? ` (${node.WiFi_RSSI} dBm)` : '';
          elStatus.textContent = `${node.Status}${rssi}`;
        }
        if (pillPump) {
          pillPump.textContent = `Pump: ${isPumpOn ? 'ON' : 'OFF'}`;
          pillPump.className = `node-pill ${isPumpOn ? 'active' : ''}`;
        }
        if (pillFan) {
          pillFan.textContent = `Fan: ${isFanOn ? 'ON' : 'OFF'}`;
          pillFan.className = `node-pill ${isFanOn ? 'active' : ''}`;
        }
      }
    }
  } catch (e) {}
}

// ============================================================================
// USER ACCOUNT & MULTI-DEVICE MANAGEMENT MODULE
// ============================================================================
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

async function switchActiveDevice(devId) {
  const target = registeredDevices.find(d => d.id === devId);
  if (!target) return;

  activeDeviceId = devId;
  localStorage.setItem("soil_air_active_dev_id", activeDeviceId);

  cachedShallowKeys = null;
  lastShallowFetchTime = 0;

  updateActiveDeviceBanner();
  renderDevicesList();

  rawTelemetryHistory = [];
  filteredHistory = [];
  loadCachedTelemetryData();
  await fetchInitialHistory();
  await fetchTelemetryData();
  fetchActuatorNodeStatus();
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

  // 1. Quick Header Theme Toggle Button
  const btnToggle = document.getElementById("btn-toggle-theme");
  if (btnToggle) {
    btnToggle.addEventListener("click", () => {
      const isLight = document.body.classList.contains("theme-light");
      applyAppTheme(isLight ? "dark" : "light");
    });
  }

  // 2. Settings Panel Theme Mode Selector
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
  const btnToggle = document.getElementById("btn-toggle-theme");

  const themeBtns = document.querySelectorAll(".btn-theme-select");
  themeBtns.forEach(b => {
    if (b.getAttribute("data-theme") === themeName) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  });

  let isLightActive = false;
  if (themeName === "light") {
    document.body.classList.add("theme-light");
    isLightActive = true;
    if (badge) badge.textContent = "Light Theme";
  } else if (themeName === "system") {
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    if (prefersLight) {
      document.body.classList.add("theme-light");
      isLightActive = true;
      if (badge) badge.textContent = "System (Light)";
    } else {
      document.body.classList.remove("theme-light");
      isLightActive = false;
      if (badge) badge.textContent = "System (Dark)";
    }
  } else {
    document.body.classList.remove("theme-light");
    isLightActive = false;
    if (badge) badge.textContent = "Dark Theme";
  }

  // Update header quick toggle button state
  if (btnToggle) {
    if (isLightActive) {
      btnToggle.innerHTML = '<i class="fa-solid fa-moon"></i>';
      btnToggle.title = "Switch to Dark Theme";
    } else {
      btnToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
      btnToggle.title = "Switch to Light (Apple White) Mode";
    }
  }

  // Dynamically refresh Chart.js gridlines and labels
  refreshChartsTheme();
}

function refreshChartsTheme() {
  const isLight = document.body.classList.contains("theme-light");
  const gridColor = isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.04)";
  const tickColor = isLight ? "#6e6e73" : "#64748b";
  const legendColor = isLight ? "#1d1d1f" : "#cbd5e1";

  const charts = [
    typeof temperatureChart !== 'undefined' ? temperatureChart : null,
    typeof humidityChart !== 'undefined' ? humidityChart : null,
    typeof pressureChart !== 'undefined' ? pressureChart : null,
    typeof soilMoistureChart !== 'undefined' ? soilMoistureChart : null,
    typeof soilTempChart !== 'undefined' ? soilTempChart : null
  ];

  charts.forEach(c => {
    if (c && c.options && c.options.scales) {
      if (c.options.scales.x) {
        if (c.options.scales.x.grid) c.options.scales.x.grid.color = gridColor;
        if (c.options.scales.x.ticks) c.options.scales.x.ticks.color = tickColor;
      }
      if (c.options.scales.y) {
        if (c.options.scales.y.grid) c.options.scales.y.grid.color = gridColor;
        if (c.options.scales.y.ticks) c.options.scales.y.ticks.color = isLight ? "#6e6e73" : "#94a3b8";
      }
      if (c.options.plugins && c.options.plugins.legend && c.options.plugins.legend.labels) {
        c.options.plugins.legend.labels.color = legendColor;
      }
      try { c.update('none'); } catch(e) {}
    }
  });
}
