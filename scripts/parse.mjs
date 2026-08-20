#!/usr/bin/env node
// GitHub Actions에서 실행되는 파서: uploads/ 아래 새로 커밋된 Capacity Plan / ROB Report를 읽어
// Google Gemini API(무료 티어)로 구조화 데이터를 추출하고, data/ 아래 JSON으로 기록한다.
// (vessel-dashboard/app/api/analyze-contract/route.ts 의 PDF->JSON 분석 패턴과 동일한 계열의
// 방식이며, 그 파일은 SDK를 쓰지만 여기서는 GitHub Actions에 SDK 의존성을 늘리지 않기 위해
// REST API를 직접 fetch로 호출한다.)
//
// 설계 원칙 (Bunker.md 참고):
// - ROB는 항상 G.O.V.(실측 부피) 기준. 중량(MT)만 있는 Report는 밀도를 역산해 부피로 환산.
// - Tank 이름이 암시하는 Grade보다 Report가 명시한 Grade가 항상 우선.
// - 화면에 그려지는 것은 STORAGE + onShell + capacity>=100 인 Tank뿐이므로, 그 외(SERVICE/
//   SETTLING/OVERFLOW/DRAIN, 또는 이중저처럼 onShell=false인 Tank)의 좌표는 렌더링에 전혀
//   쓰이지 않는다 -- 그래서 AI에게는 좌표를 만들게 하지 않고, Frame 범위/용량/역할만 추출하게 한
//   뒤 이 스크립트가 결정론적으로 좌표를 계산한다 (일관된 선미 실루엣 유지, 좌표 환각 방지).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DATA_DIR = path.join(ROOT, "data");

const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const MODEL = process.env.BUNKER_MODEL || "gemini-3.6-flash";

// bunker-plan-console.html 아티팩트의 HULL_TEMPLATE / makeFrameToX 를 그대로 이식한 값.
// 모든 선박이 이 값을 공유해야 선미 실루엣(쐐기 모양/Port-Starboard 간격)이 항상 동일하게 나온다.
const HULL_TEMPLATE = { CL_Y: 325, BOX_H: 130, SIDE_GAP: 65, STERN_X: 170, STERN_HALF: 91, GRID_LEFT_X: 606 };
const PORT_Y = HULL_TEMPLATE.CL_Y - HULL_TEMPLATE.SIDE_GAP - HULL_TEMPLATE.BOX_H;
const STBD_Y = HULL_TEMPLATE.CL_Y + HULL_TEMPLATE.SIDE_GAP;
const DEFAULT_PX_PER_FRAME = 24;

function isVisibleSpec(t) {
  return t.role === "STORAGE" && t.onShell === true && typeof t.capacity === "number" && t.capacity >= 100;
}

// AI가 반환한 {name, frameFrom, frameTo, capacity, side, role, onShell} 목록을 우리 렌더러가
// 쓰는 {position,size} 포함 Tank Config로 변환한다. 숨겨진(비가시) Tank는 어차피 렌더링에
// 좌표가 쓰이지 않으므로 자리표시자만 넣는다.
function computeLayout(aiTanks, pxPerFrameHint) {
  const pxPerFrame = pxPerFrameHint && pxPerFrameHint > 0 ? pxPerFrameHint : DEFAULT_PX_PER_FRAME;
  const visibleFrames = aiTanks.filter(isVisibleSpec).map(t => t.frameFrom);
  const minVisibleFrame = visibleFrames.length > 0 ? Math.min(...visibleFrames) : Math.min(...aiTanks.map(t => t.frameFrom));
  const frameToX = (frame) => HULL_TEMPLATE.GRID_LEFT_X + (frame - minVisibleFrame) * pxPerFrame;

  return aiTanks.map((t, i) => {
    const id = slugifyId(t.name, i);
    const base = {
      id, name: t.name, group: t.side, capacity: t.capacity, role: t.role, onShell: !!t.onShell,
      order: i + 1
    };
    if (t.excludeFromTotal) base.excludeFromTotal = true;
    if (!isVisibleSpec(t)) {
      // 렌더링에 쓰이지 않는 값 (isTankVisible()이 false를 반환하는 Tank) -- 자리표시자.
      return { ...base, position: { x: 0, y: 0 }, size: { w: 0, h: 0 } };
    }
    const x = frameToX(t.frameFrom);
    const w = (t.frameTo - t.frameFrom) * pxPerFrame;
    const y = t.side === "PORT" ? PORT_Y : t.side === "STBD" ? STBD_Y : HULL_TEMPLATE.CL_Y - HULL_TEMPLATE.BOX_H / 2;
    return { ...base, position: { x, y }, size: { w, h: HULL_TEMPLATE.BOX_H } };
  });
}

function slugifyId(name, i) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `tank-${i + 1}`;
}

const GROUP_LABELS = { PORT: "PORT SIDE", CL: "CENTERLINE (SETT. / SERV.)", STBD: "STARBOARD SIDE" };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Gemini의 responseSchema는 JSON Schema가 아니라 OpenAPI 3.0 Schema 서브셋이다
// (type은 대문자: STRING/NUMBER/BOOLEAN/ARRAY/OBJECT).
// 무료 티어는 일시적인 과부하(503)/속도 제한(429)이 잦으므로, 이 두 경우만 지수 백오프로 재시도한다
// (그 외 오류는 재시도해도 반복 실패할 뿐이라 바로 던진다 -- 예: 400 잘못된 요청, 404 모델명 오류).
async function callGemini({ system, parts, schema }, attempt = 1) {
  if (!GOOGLE_GEMINI_API_KEY) throw new Error("GOOGLE_GEMINI_API_KEY 시크릿이 설정되지 않았습니다.");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GOOGLE_GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema }
    })
  });
  if (!res.ok) {
    const bodyText = (await res.text()).slice(0, 500);
    if ((res.status === 503 || res.status === 429) && attempt < 4) {
      const waitMs = attempt * 15000;
      console.warn(`[parse] Gemini API ${res.status} (일시적 과부하/속도 제한) -- ${waitMs / 1000}초 후 재시도 (${attempt}/3)`);
      await sleep(waitMs);
      return callGemini({ system, parts, schema }, attempt + 1);
    }
    throw new Error(`Gemini API 오류 (${res.status}): ${bodyText}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join("");
  if (!text) throw new Error(`Gemini가 결과를 반환하지 않았습니다: ${JSON.stringify(json).slice(0, 500)}`);
  return JSON.parse(text);
}

const VESSEL_TANKS_SCHEMA = {
  type: "OBJECT",
  required: ["vesselName", "tanks", "reportedTankCount", "reportedTotalCapacity"],
  properties: {
    vesselName: { type: "STRING", description: "예: M/T EXAMPLE PROSPERITY" },
    pxPerFrameHint: { type: "NUMBER", description: "Frame 범위가 유난히 넓은 선박(약 40개 Frame 이상)이면 16, 보통은 24로 둔다." },
    tanks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["name", "frameFrom", "frameTo", "capacity", "side", "role", "onShell"],
        properties: {
          name: { type: "STRING", description: "도면에 적힌 Tank 이름 그대로 (예: NO.2 H.F.O. TK (P))" },
          frameFrom: { type: "NUMBER" },
          frameTo: { type: "NUMBER" },
          capacity: { type: "NUMBER", description: "Capacity Plan에 명시된 100% 용량 (M3, G.O.V. 기준)" },
          side: { type: "STRING", enum: ["PORT", "STBD", "CL"], description: "PORT/STBD는 선체 외판에 붙어 좌우로 표시되는 Tank, CL은 그 외 모든 Sett./Serv./Overflow/이중저 등 숨겨지는 Tank" },
          role: { type: "STRING", enum: ["STORAGE", "SERVICE", "SETTLING", "OVERFLOW", "DRAIN"] },
          onShell: { type: "BOOLEAN", description: "선체 외판에 직접 붙어 있는 Wing/Side Tank이면 true, 이중저(Double Bottom) 등 내부 Tank면 false" },
          excludeFromTotal: { type: "BOOLEAN", description: "Overflow Tank처럼 총량 합계에서 항상 제외해야 하면 true" }
        }
      }
    },
    // 아래 두 필드는 AI 스스로 표를 다시 세어보게 해서, 코드가 tanks 배열과 대조 검산할 수 있게 하는
    // 자기 검증용 필드다 (Peru Prosperity 사건: 존재하지 않는 Starboard SETT/SERV Tank를 만들어
    // 내거나, 저유황 계열 Tank 2개를 통째로 빠뜨리고도 그럴듯한 결과를 반환한 적이 있음).
    reportedTankCount: { type: "NUMBER", description: "표에 실제로 인쇄된 연료(HFO/Diesel/MGO 등) Tank 데이터 행의 개수 (TOTAL 행 제외). tanks 배열의 길이와 반드시 같아야 한다." },
    reportedTotalCapacity: { type: "NUMBER", description: "표의 TOTAL 행에 적힌 100% FULL 용량 합계. 연료 관련 표가 여러 개(예: HEAVY FUEL OIL TANKS, DIESEL OIL TANKS)면 각 표의 TOTAL을 전부 더한 값. tanks 배열의 capacity 합계와 반드시 (반올림 오차 범위 내에서) 같아야 한다." }
  }
};

const ROB_REPORT_SCHEMA = {
  type: "OBJECT",
  required: ["reportDate", "rob", "reportedGrandTotal"],
  properties: {
    reportDate: { type: "STRING", description: "ISO 8601 형식. Report에 시각이 없으면 00:00:00으로." },
    meta: {
      type: "OBJECT",
      properties: { position: { type: "STRING" }, condition: { type: "STRING" }, trim: { type: "NUMBER" } }
    },
    rob: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["tankName", "grade", "robM3"],
        properties: {
          tankName: { type: "STRING", description: "아래 제공된 Tank 목록의 name과 최대한 일치시킬 것" },
          grade: { type: "STRING" },
          robM3: { type: "NUMBER", description: "G.O.V.(실측 부피, M3) 기준. Report에 중량(MT)만 있으면 같은 Report 내 다른 신뢰 가능한 행의 Volume/Weight 비율로 밀도를 역산해 환산할 것." }
        }
      }
    },
    // rob 배열의 robM3 합계와 코드가 대조 검산할 자기 검증용 필드 (Peru Prosperity 사건: 파일명의
    // 실제 조사일과 다른 예전 날짜의 시트를 읽어버린 적이 있음 -- 이 필드 자체는 잘못된 시트를
    // 골랐는지는 못 잡아내지만, 최소한 고른 시트 안에서 행 추출이 누락/중복 없이 됐는지는 검증한다).
    reportedGrandTotal: { type: "NUMBER", description: "Report에 적힌 모든 'Total' 행의 G.O.V.(부피) 값을 전부 합산한 값. Grade 구간이 여러 개(예: Heavy Fuel Oil Total, Diesel Oil Total)면 전부 더할 것. rob 배열의 robM3 합계와 반드시 (반올림 오차 범위 내에서) 같아야 한다." },
    notes: { type: "STRING", description: "밀도 역산을 했다면 그 계산 근거, 이름-Grade 불일치를 Report 기준으로 바로잡았다면 그 내용을 여기에 기록." }
  }
};

const SHARED_PRINCIPLES = `
다음 원칙을 반드시 지켜라 (실제 선박 연료 재고 데이터이므로 정확성이 매우 중요하다):
1. ROB는 항상 G.O.V.(실측 부피, Gross Observed Volume)를 사용한다. G.S.V.(15도씨 표준 환산 부피)가 별도로 있다면 그것을 쓰지 말고 G.O.V.를 써라.
2. Tank의 물리적 이름이 어떤 연료(예: "LS FO", "H.F.O.")를 암시하더라도, Report 자체가 명시한 Grade 구분(표 제목, 합계 라벨, Grade 컬럼 등)이 항상 우선한다. 이름과 명시된 Grade가 다르면 명시된 Grade를 따르고 notes에 기록하라.
3. Report에 부피(Volume/M3/G.O.V.) 컬럼이 없고 중량(Weight/MT)만 있다면, 같은 Report 안에서 Volume과 Weight가 함께 있는 동일 적재율 행들을 찾아 Grade 계열별 밀도(Weight/Volume)를 역산하고, 그 밀도로 중량만 있는 항목을 부피로 환산하라. 계산에 쓴 값이 물리적으로 불가능하면(예: 밀도가 1.0을 넘는 등) 그 행은 버리고 다른 신뢰 가능한 행으로 다시 계산하라. 환산 후 가능하면 Report에 표시된 계열 합계(Total MT)와 일치하는지 스스로 검산하라.
4. grade 값은 반드시 다음 표준 코드 중 하나로만 적어라: VLSFO, HFO, HSFO, LSFO, LSHFO, MGO, LSMGO. Report의 원문 표기가 이와 다르게 쓰여 있어도(예: "HIGH SULPHUR HFO", "MARINE GAS OIL", "M.D.O.") 의미가 가장 가까운 표준 코드로 변환해서 적어라 (고유황유 계열은 HFO/HSFO 중 하나, 저유황 경유 계열은 보통 LSMGO, 일반 경유는 MGO). 표준 코드 중 어느 것과도 의미가 명확히 다른 특수한 Grade만 예외적으로 원문 그대로 적고 notes에 이유를 남겨라.
5. 표/문서에 실제로 인쇄되어 있는 항목만 나열하라. Port에 어떤 Tank가 있다고 해서 Starboard에도
   똑같은 이름/용량의 Tank가 있을 것이라고 추측해서 만들어내지 마라 -- 실제로는 좌우가 비대칭인
   경우가 많다(예: Port에만 Settling/Service Tank가 있고 Starboard엔 없음, 또는 Port/Starboard
   Tank의 용량이나 계열(Grade)이 서로 다름). 표에 없는 Overflow/여분 Tank도 만들어내지 마라.
   반대로 표에 있는 항목을 누락하지도 마라 (특히 저유황(Low Sulphur/L.S./L.SUR) 계열처럼 이름이
   비슷한 Tank가 여러 줄 있을 때 일부만 뽑고 끝내는 실수를 하지 마라). 최종 결과를 표의 TOTAL
   행과 스스로 대조해서, 개수와 합계가 정확히 일치하는지 확인한 뒤에만 답하라.
`.trim();

// 코드가 AI의 자기 검증 필드(reportedTankCount/reportedTotalCapacity/reportedGrandTotal)와
// 실제 추출 결과를 대조할 때 쓰는 허용 오차. 반올림 등 정상적인 오차는 통과시키되, Peru
// Prosperity 사건 수준의 큰 불일치(수백 단위 누락/허구 생성)는 반드시 걸러낸다.
function withinTolerance(actual, expected) {
  if (typeof expected !== "number" || Number.isNaN(expected)) return true; // AI가 값을 못 줬으면 이 검증은 건너뜀(스키마 required라 보통 없음)
  const tolerance = Math.max(2, Math.abs(expected) * 0.01);
  return Math.abs(actual - expected) <= tolerance;
}

function findExisting(dataDir, vesselId) {
  const p = path.join(dataDir, "vessels", `${vesselId}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

function sanitizeSlug(reportDate) {
  return reportDate.replace(/[^0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// ROB Report 파일명에 박힌 조사일(예: "...-17.08.2026.xls")과 xlsx 시트 이름을 대조해, 여러 날짜의
// 시트가 섞여 있는 파일(Peru Prosperity 사건: "bunker survey"/지난 4월치 시트들과 실제 조사일인
// "17.08.26" 시트가 한 파일에 같이 있었음)에서 엉뚱한 과거 시트를 골라버리는 사고를 막는다.
function normalizeDmy(str) {
  const m = String(str).match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (!m) return null;
  const d = m[1].padStart(2, "0");
  const mo = m[2].padStart(2, "0");
  const y = m[3].length === 4 ? m[3].slice(2) : m[3].padStart(2, "0");
  return `${d}.${mo}.${y}`;
}

function pickReportSheetNames(sheetNames, filename) {
  if (sheetNames.length === 1) return sheetNames;
  const targetDate = normalizeDmy(filename);
  if (!targetDate) return sheetNames; // 파일명에서 날짜를 못 찾으면 기존처럼 전체 시트를 넘긴다
  const matches = sheetNames.filter(name => normalizeDmy(name) === targetDate);
  return matches.length === 1 ? matches : sheetNames; // 정확히 하나만 일치할 때만 좁히고, 애매하면 안전하게 전체를 넘긴다
}

function fuzzyMatchTankId(tankName, tanks) {
  const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const target = norm(tankName);
  const exact = tanks.find(t => norm(t.name) === target);
  if (exact) return exact.id;
  // Port/Starboard 표기가 빠지는 등으로 두 개 이상의 Tank와 동시에 부분 일치하면, 잘못 추측해서
  // 서로 다른 Tank의 ROB가 같은 tankId로 겹쳐버리는 것(validateReport가 "중복 Tank"로 잡아내지만
  // 애초에 발생하지 않는 게 낫다)보다, 매칭 실패로 처리해 _unmatched로 보내는 편이 안전하다.
  const partial = tanks.filter(t => { const cand = norm(t.name); return cand.includes(target) || target.includes(cand); });
  return partial.length === 1 ? partial[0].id : null;
}

async function processManifestDir(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { vesselId, vesselName } = manifest;
  console.log(`[parse] ${vesselId}: manifest 처리 시작`, manifest);

  let vesselConfig = findExisting(DATA_DIR, vesselId);

  if (manifest.hasCapacityPlan) {
    const filePath = path.join(dir, manifest.capacityPlanFilename);
    const bytes = fs.readFileSync(filePath);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    console.log(`[parse] ${vesselId}: Capacity Plan 분석 중 (${manifest.capacityPlanFilename})`);
    const aiResult = await callGemini({
      system: `너는 선박 Capacity Plan 도면을 읽어 Tank 목록을 구조화하는 전문가다. ${SHARED_PRINCIPLES}\nTank의 Frame 범위(FR.NO)와 100% Capacity를 표에서 정확히 읽어라. 선체 외판에 붙어 좌우로 넓게 배치된 대형 저장 Tank(Storage)는 side를 PORT 또는 STBD로, 그 외 Settling/Service/Overflow Tank나 이중저(Double Bottom) Tank는 side를 CL로 지정하라. reportedTankCount/reportedTotalCapacity는 표를 다시 한번 세어보고 채우는 자기 검산용 항목이니 대충 tanks 배열 길이/합계를 복사하지 말고 실제로 표를 다시 확인해서 채워라.`,
      parts: [
        { inlineData: { mimeType: "application/pdf", data: bytes.toString("base64") } },
        { text: "이 Capacity Plan 도면에서 선박명과 전체 Tank 목록(Fuel Oil / Diesel Oil 계열)을 추출해줘." }
      ],
      schema: VESSEL_TANKS_SCHEMA
    });
    if (aiResult.tanks.length !== aiResult.reportedTankCount) {
      throw new Error(`Capacity Plan 판독 불일치: 추출된 Tank 개수(${aiResult.tanks.length})가 AI 스스로 센 표 행 개수(${aiResult.reportedTankCount})와 다릅니다. Tank를 빠뜨렸거나(누락) 존재하지 않는 Tank를 만들어냈을 가능성이 있습니다 -- 사람이 원본 PDF를 직접 확인해야 합니다.`);
    }
    const extractedTotal = aiResult.tanks.reduce((sum, t) => sum + (typeof t.capacity === "number" ? t.capacity : 0), 0);
    if (!withinTolerance(extractedTotal, aiResult.reportedTotalCapacity)) {
      throw new Error(`Capacity Plan 판독 불일치: 추출된 Tank들의 Capacity 합계(${extractedTotal})가 표의 TOTAL(${aiResult.reportedTotalCapacity})과 다릅니다. Capacity 오독이나 Tank 누락/허구 생성 가능성이 있습니다 -- 사람이 원본 PDF를 직접 확인해야 합니다.`);
    }
    const tanks = computeLayout(aiResult.tanks, aiResult.pxPerFrameHint);
    const groupsPresent = [...new Set(tanks.map(t => t.group))];
    vesselConfig = {
      vesselId,
      // 업로드 화면에서 사용자가 직접 입력한 선박명을 우선한다 -- 도면에는 매각/개명 전의
      // 예전 선명(예: 자매선 도면 재사용 시)이나 조선소 Hull 표기가 적혀 있을 수 있기 때문에,
      // AI가 도면에서 읽은 이름은 사용자가 이름을 안 준 경우의 최후 대안으로만 쓴다.
      vesselName: vesselName || aiResult.vesselName,
      sourceHash: sha256,
      sourceFile: manifest.capacityPlanFilename,
      // 나중에 이 선박 데이터를 사람이 재검토할 때(예: 다른 Report 추가 시 원본 대조) 쓸 수 있도록
      // AI가 읽은 표의 TOTAL을 그대로 남겨둔다 -- 검증 로직이 이미 이 값과 tanks 합계 일치를
      // 확인했으므로 신뢰할 수 있는 참고값이다.
      sourceReportedTankCount: aiResult.reportedTankCount,
      sourceReportedTotalCapacity: aiResult.reportedTotalCapacity,
      display: { decimals: 1, unit: "M³", missingLabel: "N/A", minVisibleCapacity: 100 },
      hull: { centerlineY: HULL_TEMPLATE.CL_Y, sternLine: { x: HULL_TEMPLATE.STERN_X, yTop: HULL_TEMPLATE.CL_Y - HULL_TEMPLATE.STERN_HALF, yBottom: HULL_TEMPLATE.CL_Y + HULL_TEMPLATE.STERN_HALF } },
      groups: groupsPresent.map(id => ({ id, label: GROUP_LABELS[id] || id })),
      tanks
    };
    fs.mkdirSync(path.join(DATA_DIR, "vessels"), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "vessels", `${vesselId}.json`), JSON.stringify(vesselConfig, null, 2));
    console.log(`[parse] ${vesselId}: data/vessels/${vesselId}.json 작성 완료 (Tank ${tanks.length}개)`);
  }

  let reportRecord = null;
  if (manifest.hasRobReport) {
    if (!vesselConfig) throw new Error(`${vesselId}: ROB Report는 있는데 Capacity Plan(기존/신규)이 없어 Tank 목록을 알 수 없습니다.`);
    const filePath = path.join(dir, manifest.robReportFilename);
    const ext = path.extname(manifest.robReportFilename).toLowerCase();
    const knownTanks = vesselConfig.tanks.map(t => ({ id: t.id, name: t.name }));
    console.log(`[parse] ${vesselId}: ROB Report 분석 중 (${manifest.robReportFilename})`);

    const tankListInstruction = `아래는 이 선박의 알려진 Tank 목록이다 (tankName에는 이 목록에 있는 name 값을 철자/기호까지 정확히 그대로 복사해서 적어라 (Port/Starboard 등을 짐작해서 새로 만들지 말고, 이 목록에 없는 이름은 절대 쓰지 말 것)):\n${JSON.stringify(knownTanks)}`;

    let aiResult;
    if (ext === ".xlsx" || ext === ".xls") {
      const wb = XLSX.readFile(filePath);
      const sheetNamesToUse = pickReportSheetNames(wb.SheetNames, manifest.robReportFilename);
      if (sheetNamesToUse.length < wb.SheetNames.length) {
        console.log(`[parse] ${vesselId}: 파일명 날짜와 일치하는 시트만 사용: ${sheetNamesToUse.join(", ")} (전체 시트: ${wb.SheetNames.join(", ")})`);
      } else if (wb.SheetNames.length > 1) {
        console.warn(`[parse] ${vesselId}: 시트가 ${wb.SheetNames.length}개인데 파일명 날짜와 정확히 일치하는 시트를 찾지 못해 전체 시트를 AI에게 넘깁니다 -- 과거 날짜 시트를 잘못 고를 위험이 있으니 reportDate와 결과를 꼼꼼히 검토하세요.`);
      }
      const sheets = {};
      for (const name of sheetNamesToUse) sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
      aiResult = await callGemini({
        system: `너는 선박 Bunker ROB Report 표를 읽어 Tank별 ROB를 구조화하는 전문가다. ${SHARED_PRINCIPLES}\n이 파일에 여러 날짜의 시트가 섞여 있을 수 있다 -- 반드시 실제 조사일(파일명 또는 시트 안의 Date 항목)에 해당하는 시트 하나만 사용하고, 지난 날짜의 오래된 시트를 쓰지 마라.`,
        parts: [
          { text: `${tankListInstruction}\n\n아래는 Excel Report의 원본 표(시트별 2차원 배열, header:1)이다:\n${JSON.stringify(sheets)}` }
        ],
        schema: ROB_REPORT_SCHEMA
      });
    } else {
      const bytes = fs.readFileSync(filePath);
      aiResult = await callGemini({
        system: `너는 선박 Bunker ROB Report를 읽어 Tank별 ROB를 구조화하는 전문가다. ${SHARED_PRINCIPLES}`,
        parts: [
          { inlineData: { mimeType: "application/pdf", data: bytes.toString("base64") } },
          { text: `${tankListInstruction}\n\n이 Bunker ROB Report에서 Tank별 ROB를 추출해줘.` }
        ],
        schema: ROB_REPORT_SCHEMA
      });
    }

    const extractedRobTotal = aiResult.rob.reduce((sum, r) => sum + (typeof r.robM3 === "number" ? r.robM3 : 0), 0);
    if (!withinTolerance(extractedRobTotal, aiResult.reportedGrandTotal)) {
      throw new Error(`ROB Report 판독 불일치: 추출된 ROB 합계(${extractedRobTotal})가 Report의 TOTAL 합계(${aiResult.reportedGrandTotal})와 다릅니다. 행 누락/중복이나 잘못된(예: 오래된) 시트를 읽었을 가능성이 있습니다 -- 사람이 원본 Report를 직접 확인해야 합니다.`);
    }

    const rob = [];
    const unmatched = [];
    for (const entry of aiResult.rob) {
      const tankId = fuzzyMatchTankId(entry.tankName, vesselConfig.tanks);
      if (tankId) rob.push({ tankId, grade: entry.grade, rob: entry.robM3 });
      else unmatched.push(entry);
    }
    if (unmatched.length > 0) console.warn(`[parse] ${vesselId}: 매칭 실패한 ROB 항목 (검토 필요):`, unmatched);
    if (aiResult.notes) console.log(`[parse] ${vesselId}: AI notes: ${aiResult.notes}`);

    reportRecord = { vesselId, reportDate: aiResult.reportDate, meta: aiResult.meta || {}, rob };
    if (unmatched.length > 0) reportRecord._unmatched = unmatched;
    const slug = sanitizeSlug(aiResult.reportDate);
    fs.mkdirSync(path.join(DATA_DIR, "reports", vesselId), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "reports", vesselId, `${slug}.json`), JSON.stringify(reportRecord, null, 2));
    console.log(`[parse] ${vesselId}: data/reports/${vesselId}/${slug}.json 작성 완료`);
    return { vesselId, vesselName: vesselConfig.vesselName, reportSlug: slug, reportDate: aiResult.reportDate };
  }
  return { vesselId, vesselName: vesselConfig.vesselName, reportSlug: null, reportDate: null };
}

function updateIndex(results) {
  const indexPath = path.join(DATA_DIR, "index.json");
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : [];
  for (const r of results) {
    if (!r) continue;
    let entry = index.find(v => v.vesselId === r.vesselId);
    if (!entry) { entry = { vesselId: r.vesselId, vesselName: r.vesselName, reports: [] }; index.push(entry); }
    entry.vesselName = r.vesselName;
    if (r.reportSlug && !entry.reports.some(x => x.slug === r.reportSlug)) {
      entry.reports.push({ slug: r.reportSlug, reportDate: r.reportDate });
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

async function main() {
  if (!fs.existsSync(UPLOADS_DIR)) { console.log("[parse] uploads/ 없음 -- 처리할 것 없음"); return; }
  const vesselDirs = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  const results = [];
  for (const vd of vesselDirs) {
    const vesselPath = path.join(UPLOADS_DIR, vd.name);
    const tsDirs = fs.readdirSync(vesselPath, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const td of tsDirs) {
      const dir = path.join(vesselPath, td.name);
      try {
        const result = await processManifestDir(dir);
        results.push(result);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[parse] ${dir} 처리 실패:`, err.message);
        throw err; // Action을 실패시켜 사람이 로그를 보고 원인을 확인하게 한다.
      }
    }
    // 선박 폴더가 비었으면 정리
    if (fs.readdirSync(vesselPath).length === 0) fs.rmSync(vesselPath, { recursive: true, force: true });
  }
  if (results.length > 0) updateIndex(results);
  console.log(`[parse] 완료: ${results.length}건 처리`);
}

main().catch(err => { console.error(err); process.exit(1); });
