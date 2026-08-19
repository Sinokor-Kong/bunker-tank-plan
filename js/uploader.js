// ============================================================
// Drag & Drop 업로더: Capacity Plan(Drawing) / Bunker ROB Report 파일을 GitHub 저장소의
// uploads/ 폴더에 커밋한다 -- 실제 AI 분석은 여기서 하지 않고, 이 커밋이 트리거하는
// .github/workflows/parse-bunker-upload.yml (GitHub Actions)이 처리한다.
//
// 핵심 절약 로직: Capacity Plan 파일의 SHA-256 해시를 브라우저에서 미리 계산해 현재 저장된
// data/vessels/<id>.json 의 sourceHash 와 같으면, 그 파일은 아예 업로드하지 않는다 (도면이
// 안 바뀌었으면 기존 스케치를 그대로 재사용 -- Actions/Claude API 호출 자체가 발생하지 않음).
// ============================================================
const GITHUB_OWNER = "Sinokor-Kong";
const GITHUB_REPO = "bunker-tank-plan";
const PAT_STORAGE_KEY = "bunker_gh_pat";

function getStoredPat() { return localStorage.getItem(PAT_STORAGE_KEY) || ""; }
function setStoredPat(v) { localStorage.setItem(PAT_STORAGE_KEY, v); }

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function ghRequest(path, options = {}) {
  const pat = getStoredPat();
  if (!pat) throw new Error("GitHub Token이 설정되지 않았습니다. 먼저 설정 패널에서 Token을 입력하세요.");
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API 오류 (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function commitFile(path, base64Content, message) {
  return ghRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: base64Content })
  });
}

async function tryFetchVesselConfig(vesselId) {
  try {
    const res = await fetch(`data/vessels/${vesselId}.json`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "upload-status" + (kind ? ` upload-status--${kind}` : "");
}

async function waitForRunAndPR(statusEl, afterTimestampMs) {
  setStatus(statusEl, "GitHub Actions가 분석 중입니다... (보통 30~90초 소요)", "pending");
  const deadline = Date.now() + 6 * 60 * 1000; // 6분 타임아웃
  let run = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const runs = await ghRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?event=push&per_page=10`);
    run = (runs.workflow_runs || []).find(r => new Date(r.created_at).getTime() >= afterTimestampMs - 5000);
    if (run && run.status === "completed") break;
    if (run) setStatus(statusEl, `분석 진행 중... (${run.status})`, "pending");
  }
  if (!run) { setStatus(statusEl, "Actions 실행을 찾지 못했습니다. 저장소의 Actions 탭에서 직접 확인해주세요.", "warn"); return; }
  if (run.conclusion !== "success") {
    setStatus(statusEl, `분석 실패 (conclusion: ${run.conclusion}). Actions 로그를 확인하세요: ${run.html_url}`, "error");
    return;
  }
  const prs = await ghRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=open&sort=created&direction=desc&per_page=5`);
  const pr = (prs || []).find(p => new Date(p.created_at).getTime() >= afterTimestampMs - 15000);
  if (pr) {
    setStatus(statusEl, "", "success");
    statusEl.innerHTML = `분석 완료 — 결과를 검토하고 병합하면 사이트에 반영됩니다: <a href="${pr.html_url}" target="_blank" rel="noopener">${pr.html_url}</a>`;
  } else {
    setStatus(statusEl, "분석은 끝났지만 PR을 찾지 못했습니다 (변경사항이 없었을 수 있습니다). Actions 로그를 확인하세요.", "warn");
  }
}

function initUploader() {
  const form = document.getElementById("uploader-form");
  if (!form) return;

  const patInput = document.getElementById("gh-pat-input");
  patInput.value = getStoredPat();
  document.getElementById("gh-pat-save").addEventListener("click", () => {
    setStoredPat(patInput.value.trim());
    setStatus(document.getElementById("upload-status"), "Token이 저장되었습니다.", "success");
  });

  const modeSelect = document.getElementById("upload-mode");
  const existingVesselSelect = document.getElementById("upload-existing-vessel");
  const newVesselNameInput = document.getElementById("upload-new-vessel-name");

  function applyMode() {
    const isNew = modeSelect.value === "new";
    document.getElementById("upload-existing-row").style.display = isNew ? "none" : "flex";
    document.getElementById("upload-new-row").style.display = isNew ? "flex" : "none";
  }
  modeSelect.addEventListener("change", applyMode);
  applyMode();

  function populateExistingVessels() {
    existingVesselSelect.innerHTML = "";
    for (const entry of App.getIndex()) {
      const opt = document.createElement("option");
      opt.value = entry.vesselId;
      opt.textContent = entry.vesselName;
      existingVesselSelect.appendChild(opt);
    }
  }
  populateExistingVessels();
  window.addEventListener("bunker:data-updated", populateExistingVessels);

  function setupDropZone(zoneId, inputId, accept) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drop-zone--over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-zone--over"));
    zone.addEventListener("drop", e => {
      e.preventDefault();
      zone.classList.remove("drop-zone--over");
      if (e.dataTransfer.files[0]) { input.files = e.dataTransfer.files; updateZoneLabel(zone, input); }
    });
    input.addEventListener("change", () => updateZoneLabel(zone, input));
  }
  function updateZoneLabel(zone, input) {
    const label = zone.querySelector(".drop-zone__label");
    label.textContent = input.files[0] ? input.files[0].name : label.dataset.placeholder;
  }
  setupDropZone("drop-zone-capacity", "input-capacity", ".pdf");
  setupDropZone("drop-zone-rob", "input-rob", ".xlsx,.xls,.pdf");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById("upload-status");
    try {
      const isNew = modeSelect.value === "new";
      const vesselName = isNew ? newVesselNameInput.value.trim() : (App.getIndex().find(v => v.vesselId === existingVesselSelect.value)?.vesselName || "");
      const vesselId = isNew ? slugify(newVesselNameInput.value) : existingVesselSelect.value;
      if (!vesselId) throw new Error("선박을 선택하거나 신규 선박명을 입력하세요.");

      const capacityFile = document.getElementById("input-capacity").files[0] || null;
      const robFile = document.getElementById("input-rob").files[0] || null;
      if (!robFile) throw new Error("Bunker ROB Report 파일은 필수입니다.");
      if (isNew && !capacityFile) throw new Error("신규 선박은 Capacity Plan(Drawing)이 반드시 필요합니다.");

      let includeCapacity = !!capacityFile;
      if (capacityFile && !isNew) {
        setStatus(statusEl, "Capacity Plan 변경 여부 확인 중...", "pending");
        const newHash = await sha256Hex(capacityFile);
        const existing = await tryFetchVesselConfig(vesselId);
        if (existing && existing.sourceHash === newHash) {
          includeCapacity = false;
          setStatus(statusEl, "Capacity Plan이 기존과 동일 — 도면 재분석 없이 기존 스케치를 재사용합니다.", "pending");
        }
      }

      const ts = Date.now();
      const uploadBase = `uploads/${vesselId}/${ts}`;
      const manifest = {
        vesselId, vesselName, isNewVessel: isNew,
        hasCapacityPlan: includeCapacity, capacityPlanFilename: includeCapacity ? capacityFile.name : null,
        hasRobReport: true, robReportFilename: robFile.name,
        uploadedAt: new Date(ts).toISOString()
      };

      setStatus(statusEl, "파일 업로드 중...", "pending");
      if (includeCapacity) {
        const b64 = await fileToBase64(capacityFile);
        await commitFile(`${uploadBase}/${capacityFile.name}`, b64, `bunker: upload capacity plan for ${vesselId}`);
      }
      const robB64 = await fileToBase64(robFile);
      await commitFile(`${uploadBase}/${robFile.name}`, robB64, `bunker: upload ROB report for ${vesselId}`);
      const manifestB64 = btoa(unescape(encodeURIComponent(JSON.stringify(manifest, null, 2))));
      await commitFile(`${uploadBase}/manifest.json`, manifestB64, `bunker: manifest for ${vesselId} upload`);

      await waitForRunAndPR(statusEl, ts);
    } catch (err) {
      setStatus(document.getElementById("upload-status"), err.message, "error");
    }
  });
}

window.addEventListener("DOMContentLoaded", initUploader);
