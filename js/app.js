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

// 3D VIEW는 완전히 별도 기능이라, 아래 모듈이 없거나(아직 로드 전) 3D 내부에서 예외가 나도
// 2D Plan/Table 렌더링에는 절대 영향이 없어야 한다 -- render3d 관련 호출은 항상 이 변수들과
// try/catch로만 접근한다.
let last3D = { vesselConfig: null, report: null };
let render3DModule = null;
let is3DViewActive = false;

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

  // 2D와 동일한 검증 게이트를 통과한 데이터만 3D에도 전달한다. 3D 모듈이 아직 로드되지
  // 않았거나(사용자가 3D 탭을 연 적 없음) 3D가 지금 보이는 상태가 아니면 굳이 그리지 않는다 --
  // 3D 탭을 열 때 최신 상태로 다시 그려준다(아래 setup3DToggle 참고).
  last3D = { vesselConfig, report };
  if (is3DViewActive && render3DModule) {
    try {
      render3DModule.render3D(vesselConfig, report, document.getElementById("view-3d-container"));
    } catch (err) {
      console.error("[3D VIEW] 렌더링 실패:", err);
    }
  }

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

// 3D VIEW 토글: Three.js는 실제로 3D 탭을 처음 열 때만 동적 import()로 로드한다 (2D만 쓰는
// 사용자는 네트워크/파싱 비용이 전혀 없음). 로드/렌더링이 실패해도 2D Plan에는 영향이 없도록
// 항상 try/catch로 감싼다.
function setup3DToggle() {
  const btn2d = document.getElementById("view-toggle-2d");
  const btn3d = document.getElementById("view-toggle-3d");
  const wrap3d = document.getElementById("view-3d-wrap");
  const container3d = document.getElementById("view-3d-container");

  async function showPlan2D() {
    is3DViewActive = false;
    btn2d.classList.add("view-toggle-btn--active");
    btn3d.classList.remove("view-toggle-btn--active");
    wrap3d.style.display = "none";
    document.getElementById("plan-container").style.display = "";
    document.getElementById("table-container").style.display = "";
  }

  async function showPlan3D() {
    is3DViewActive = true;
    btn3d.classList.add("view-toggle-btn--active");
    btn2d.classList.remove("view-toggle-btn--active");
    document.getElementById("plan-container").style.display = "none";
    document.getElementById("table-container").style.display = "none";
    wrap3d.style.display = "";

    if (!last3D.vesselConfig) return; // 선박이 아직 선택되기 전이면 아무것도 안 함
    try {
      if (!render3DModule) render3DModule = await import("./render3d.js");
      render3DModule.render3D(last3D.vesselConfig, last3D.report, container3d);
    } catch (err) {
      console.error("[3D VIEW] 로드/렌더링 실패:", err);
      container3d.textContent = "3D 뷰를 불러올 수 없습니다.";
    }
  }

  btn2d.addEventListener("click", showPlan2D);
  btn3d.addEventListener("click", showPlan3D);
}

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
  setup3DToggle();

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
