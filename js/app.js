// ============================================================
// App wiring: 아티팩트 버전과 다른 점은 VESSELS 배열이 메모리에 미리 없고,
// data/index.json + data/vessels/*.json + data/reports/*/*.json 을 fetch로 읽어온다는 것뿐이다.
// 렌더링/검증 로직(renderVessel 이하)은 아티팩트에서 그대로 가져왔다.
// ============================================================
async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

function renderVessel(vesselEntry, report) {
  const vesselConfig = vesselEntry.config;
  document.getElementById("vessel-name").textContent = vesselConfig.vesselName;

  const { blocking, warnings } = validateReport(vesselConfig, report);
  const errorBox = document.getElementById("errors");
  const warningBox = document.getElementById("warnings");
  const container = document.getElementById("plan-container");

  if (blocking.length > 0) {
    errorBox.style.display = "block";
    errorBox.innerHTML = "<strong>Graphic 생성 중단 - 아래 오류를 수정하세요:</strong><ul>" + blocking.map(m => `<li>${m}</li>`).join("") + "</ul>";
    container.innerHTML = "";
    document.getElementById("table-container").innerHTML = "";
    document.getElementById("totals").innerHTML = "";
    return;
  }
  errorBox.style.display = "none";

  if (warnings.length > 0) {
    warningBox.style.display = "block";
    warningBox.innerHTML = "<strong>참고 (Graphic은 정상 생성됨):</strong><ul>" + warnings.map(m => `<li>${m}</li>`).join("") + "</ul>";
  } else {
    warningBox.style.display = "none";
  }

  renderTankPlan(vesselConfig, report, container);
  renderDataTable(vesselConfig, report, document.getElementById("table-container"));

  const robAsOfEl = document.getElementById("rob-as-of");
  robAsOfEl.textContent = report.reportDate ? `ROB as of ${formatReportDate(report.reportDate)}` : "";

  const tanksById = new Map(vesselConfig.tanks.map(t => [t.id, t]));
  const totalsByGrade = {};
  for (const e of report.rob) {
    const tank = tanksById.get(e.tankId);
    if (!tank || tank.excludeFromTotal || !isTankVisible(vesselConfig, tank)) continue;
    totalsByGrade[e.grade] = (totalsByGrade[e.grade] || 0) + e.rob;
  }
  const decimals = vesselConfig.display?.decimals ?? 1;
  const unit = vesselConfig.display?.unit ?? "MT";
  const totalsEl = document.getElementById("totals");
  totalsEl.innerHTML = Object.entries(totalsByGrade)
    .map(([grade, total]) => `<span class="total-chip">${grade} <b>${total.toFixed(decimals)} ${unit}</b></span>`)
    .join("") +
    `<span class="total-chip total-chip--sum">TOTAL <b>${Object.values(totalsByGrade).reduce((a, b) => a + b, 0).toFixed(decimals)} ${unit}</b></span>`;
}

function formatReportDate(reportDate) {
  const d = new Date(reportDate);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 한 선박이 여러 날짜의 Report를 가질 수 있으므로, 날짜 선택 Dropdown은 최신 날짜가 맨 위
// (기본 선택)로 오도록 내림차순 정렬해서 보여준다.
function populateDateSelect(vesselEntry) {
  const dateSelect = document.getElementById("date-select");
  dateSelect.innerHTML = "";
  const sortedIndexes = vesselEntry.reports
    .map((report, i) => i)
    .sort((a, b) => new Date(vesselEntry.reports[b].reportDate) - new Date(vesselEntry.reports[a].reportDate));
  for (const i of sortedIndexes) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = formatReportDate(vesselEntry.reports[i].reportDate);
    dateSelect.appendChild(opt);
  }
}

const App = (() => {
  let fleetIndex = [];
  const vesselCache = new Map(); // vesselId -> { config, reports }

  async function loadVessel(vesselId) {
    if (vesselCache.has(vesselId)) return vesselCache.get(vesselId);
    const indexEntry = fleetIndex.find(v => v.vesselId === vesselId);
    const config = await fetchJSON(`data/vessels/${vesselId}.json`);
    const reports = await Promise.all(
      indexEntry.reports.map(r => fetchJSON(`data/reports/${vesselId}/${r.slug}.json`))
    );
    const vesselEntry = { config, reports };
    vesselCache.set(vesselId, vesselEntry);
    return vesselEntry;
  }

  // 업로더가 새 선박/새 Report를 커밋한 뒤 GitHub Pages가 재배포되면, 캐시를 지우고
  // fleetIndex를 다시 읽어와야 새로 들어온 데이터가 드롭다운에 보인다.
  async function reload() {
    vesselCache.clear();
    fleetIndex = await fetchJSON("data/index.json");
    return fleetIndex;
  }

  function getIndex() { return fleetIndex; }

  return { loadVessel, reload, getIndex };
})();

async function boot() {
  const vesselSelect = document.getElementById("vessel-select");
  const dateSelect = document.getElementById("date-select");

  function populateVesselOptions() {
    const prevValue = vesselSelect.value;
    vesselSelect.innerHTML = "";
    for (const entry of App.getIndex()) {
      const opt = document.createElement("option");
      opt.value = entry.vesselId;
      opt.textContent = entry.vesselName;
      vesselSelect.appendChild(opt);
    }
    if (prevValue && App.getIndex().some(v => v.vesselId === prevValue)) vesselSelect.value = prevValue;
  }

  async function renderCurrentSelection() {
    const vesselEntry = await App.loadVessel(vesselSelect.value);
    const report = vesselEntry.reports[Number(dateSelect.value)];
    renderVessel(vesselEntry, report);
  }

  async function selectVessel(vesselId) {
    vesselSelect.value = vesselId;
    const vesselEntry = await App.loadVessel(vesselId);
    populateDateSelect(vesselEntry);
    await renderCurrentSelection();
  }

  vesselSelect.addEventListener("change", () => selectVessel(vesselSelect.value));
  dateSelect.addEventListener("change", renderCurrentSelection);

  await App.reload();
  populateVesselOptions();
  if (App.getIndex().length > 0) await selectVessel(App.getIndex()[0].vesselId);

  // uploader.js 에서 새 데이터가 반영된 것을 확인하면 이 이벤트를 보내 목록/화면을 갱신한다.
  window.addEventListener("bunker:data-updated", async () => {
    const previouslySelected = vesselSelect.value;
    await App.reload();
    populateVesselOptions();
    await selectVessel(vesselSelect.value || previouslySelected || App.getIndex()[0]?.vesselId);
  });
}

window.addEventListener("DOMContentLoaded", boot);
