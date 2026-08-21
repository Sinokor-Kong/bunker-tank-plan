// ============================================================
// 3D VIEW (Three.js) -- 기존 2D SVG Plan(js/render.js)과 완전히 별도로 동작하는 병행 뷰.
// app.js에서 "3D VIEW" 탭을 처음 열 때만 동적 import()로 로드된다 (2D만 쓰는 사용자는 비용 0).
//
// *** 이 3D VIEW는 시각화(visualization) 목적이며, 실제 선박의 정확한 3차원 형상/치수를
// 표현하지 않는다. 실제 도면 기반의 정확한 Capacity/Frame/배치 정보는 항상 기존 2D PLAN이
// 기준이다. Tank의 채워진 높이도 실제 액면(liquid level)이 아니라 ROB/Capacity 비율을 보여주는
// 시각적 fill ratio 표시일 뿐이다. *** (index.html의 안내 문구와 동일한 내용)
//
// 축 매핑: 2D Plan은 평면도(위에서 본 배치)이므로 그 좌표를 그대로 재사용한다.
//   - 2D의 x(Frame 기반) -> 3D의 길이(X) 축
//   - 2D의 y(centerlineY 기준 오프셋, Port/Starboard 실측 위치) -> 3D의 폭(Z) 축
//   - 오직 상하(Y, 선체 깊이/Tank 높이)만 실측 데이터가 없어 비율로 만들어낸다 (유일한 발명치).
// 범위: hull.sternLine.x(선미, 기존 2D 앵커)부터 가장 앞쪽 Tank의 앞쪽 끝까지 -- 선미~첫 Tank
//   사이의 선체 구간(기존 2D의 쐐기 부분)도 포함해서 압출한다. 그보다 앞쪽(선수 연장)은 만들지
//   않는다 (사용자 확정 범위).
//
// isTankVisible / visibleTanks / GRADE_PALETTE / GRADE_FALLBACK 는 classic <script>로 이미 로드된
// 전역을 그대로 재사용한다 (render.js/table.js와 동일한 원칙 -- 색/가시성 규칙을 중복 정의하지 않음).
//
// [2차 구현] 1차(선체+Tank 기본 형태+회전/확대) 확인 완료 후 추가: 클릭 인터랙션(정보 패널),
// Tank 위 이름/Grade/ROB 라벨, 선택 시 강조 표시.
// ============================================================
import * as THREE from "../vendor/three/three.module.js";
import { OrbitControls } from "../vendor/three/OrbitControls.js";

const SCALE = 1 / 40; // 2D px 좌표 -> 3D world unit (X축, 그리고 실측 데이터 없는 선박/Tank 전용)
const HULL_DEPTH_RATIO = 0.55; // principalParticulars 없는 선박에서만 쓰는 발명 비율 (폴백)
const TANK_HEIGHT_RATIO = 0.62; // 선체 깊이 대비 Tank 뼈대 높이 비율 (Tank 크기는 이번 단계에서 불변)
const TANK_BOTTOM_MARGIN_RATIO = 0.1; // 선체 바닥과 Tank 사이 여유(이중저 공간 흉내)

// Capacity Plan에서 직접 확인한 실측치(m) -> Three.js world 좌표로 옮기는 유일한 전역 스케일.
// 다른 값에서 파생시키지 않는다 -- 모든 실측 m 값(TCG/VCG/Beam/Depth)에 이 상수 하나만 곱한다.
// 값 자체는 기존 픽셀 기반(SCALE) 결과와 화면상 비슷한 크기가 나오도록 Mongolia Prosperity로
// 눈으로 맞춰본 것뿐 -- hullWidth/breadthMld 같은 계산으로 도출한 값이 아니다.
const WORLD_UNITS_PER_METER = 0.1625;

const contexts = new WeakMap(); // containerEl -> per-container three.js 상태

function colorFor(grade) {
  const style = (grade && typeof GRADE_PALETTE !== "undefined" && GRADE_PALETTE[grade]) || GRADE_FALLBACK;
  return new THREE.Color(style.fill);
}

// Tank 위에 얹는 이름/Grade/ROB 라벨을 캔버스 텍스처로 만든다 (3D 텍스트 지오메트리 대신 -- 폰트
// 로딩 없이 기존 2D와 같은 폰트 느낌을 유지할 수 있고 훨씬 가볍다).
function makeLabelTexture(lines) {
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 200;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#2b3a48"; ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = "#16212c";
  ctx.textAlign = "center";
  ctx.font = "bold 26px ui-monospace, Consolas, monospace";
  ctx.fillText(lines[0], canvas.width / 2, 46, canvas.width - 20);
  ctx.font = "22px ui-monospace, Consolas, monospace";
  ctx.fillText(lines[1], canvas.width / 2, 90);
  ctx.font = "bold 30px ui-monospace, Consolas, monospace";
  ctx.fillText(lines[2], canvas.width / 2, 140);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// 2D Plan의 실측 좌표로부터 3D에 필요한 치수를 계산한다. 길이(X)/폭(Z)은 2D 좌표를 스케일만
// 바꿔 그대로 쓰고, 깊이(Y)만 폭 대비 고정 비율로 만들어낸다.
function computeGeometry(vesselConfig) {
  const hull = vesselConfig.hull;
  if (!hull) return null;
  const tanks = visibleTanks(vesselConfig).filter(t => t.size.w > 0 && t.size.h > 0);
  if (tanks.length === 0) return null;

  const centerlineY = hull.centerlineY;
  const topRow = tanks.filter(t => t.position.y + t.size.h / 2 < centerlineY);
  const bottomRow = tanks.filter(t => t.position.y + t.size.h / 2 >= centerlineY);
  if (topRow.length === 0 || bottomRow.length === 0) return null; // 좌우 둘 다 있어야 선체 폭을 알 수 있음

  const sternX = hull.sternLine.x;
  const gridTopY = Math.min(...topRow.map(t => t.position.y));
  const gridBottomY = Math.max(...bottomRow.map(t => t.position.y + t.size.h));
  const topEndX = Math.min(...topRow.map(t => t.position.x));
  const botEndX = Math.min(...bottomRow.map(t => t.position.x));
  const maxX = Math.max(...tanks.map(t => t.position.x + t.size.w));

  const wx = (x) => (x - sternX) * SCALE;
  const wz = (y) => (y - centerlineY) * SCALE;

  // principalParticulars(실측 Beam/Depth)가 있으면 그 값 * WORLD_UNITS_PER_METER를 그대로 쓰고,
  // 없으면 지금까지 해오던 대로 2D Tank 줄 간격(픽셀) 기반 발명 비율로 폴백한다 -- 선박 단위 게이트.
  const pp = vesselConfig.principalParticulars;
  const precise = !!pp && typeof pp.breadthMld === "number" && typeof pp.depthMld === "number";
  const hullWidth = precise
    ? pp.breadthMld * WORLD_UNITS_PER_METER
    : Math.abs(wz(gridBottomY) - wz(gridTopY));
  const hullDepth = precise ? pp.depthMld * WORLD_UNITS_PER_METER : hullWidth * HULL_DEPTH_RATIO;
  const tankHeight = hullDepth * TANK_HEIGHT_RATIO;
  const tankY0 = hullDepth * TANK_BOTTOM_MARGIN_RATIO;
  const length = wx(maxX); // 선미(X=0) ~ 가장 앞쪽 Tank 앞쪽 끝까지

  return { hull, tanks, wx, wz, gridTopY, gridBottomY, topEndX, botEndX, maxX, sternX,
    hullWidth, hullDepth, tankHeight, tankY0, length, precise };
}

// Tank 중심의 Z(횡방향)/Y(수직) 좌표를 구한다. cg가 확인된 Tank는 그 실측치(m)를
// WORLD_UNITS_PER_METER 하나로만 환산해서 쓰고, cg가 없는 Tank는 기존 폴백(2D 줄 기반 Z,
// tankY0+tankHeight/2)을 그대로 쓴다 -- 선박이 아니라 Tank 단위로 개별 판정.
function tankCenterZ(tank, geo) {
  if (tank.cg && typeof tank.cg.trans === "number") return { z: tank.cg.trans * WORLD_UNITS_PER_METER, precise: true };
  const z0 = geo.wz(tank.position.y), z1 = geo.wz(tank.position.y + tank.size.h);
  return { z: (z0 + z1) / 2, precise: false };
}
function tankCenterY(tank, geo) {
  if (tank.cg && typeof tank.cg.vert === "number") return { y: tank.cg.vert * WORLD_UNITS_PER_METER, precise: true };
  return { y: geo.tankY0 + geo.tankHeight / 2, precise: false };
}

// THREE.Shape는 회전 전 로컬 XY 평면에 그려진다. 최종적으로 rotateX(-90deg)를 적용해 눕히면
// 로컬 Y부호가 반전된다(y' = z, z' = -y).
function buildHullOutlineShape(geo) {
  const { hull, wx, topEndX, botEndX, maxX, hullWidth } = geo;
  const stern = hull.sternLine;
  // 선체 폭(hullWidth)은 이제 실측 Beam이 있으면 그 값(precise 모드), 없으면 기존 2D 줄 간격
  // 기반 값 -- 두 경우 모두 Port/Starboard 줄이 Centerline에 대해 대칭이라 이 값을 그대로
  // 절반씩 나눠 쓰면(±half) 기존(줄 위치 기반) 결과와 정확히 같은 폭이 나온다.
  // 부호 규약: rotateX(-90deg) 이후 local Y부호가 반전되어 world Z = -localY가 되므로(기존
  // shapeY(y2d)=-wz(y2d) 방식과 동일한 규약을 유지해야 Tank 배치와 어긋나지 않음), Port쪽
  // (wz가 음수인 topRow)은 local +half, Starboard쪽(wz가 양수인 bottomRow)은 local -half로 둔다.
  const half = hullWidth / 2;
  const shape = new THREE.Shape();
  shape.moveTo(wx(stern.x), half);
  shape.lineTo(wx(topEndX), half);
  shape.lineTo(wx(maxX), half);
  shape.lineTo(wx(maxX), -half);
  shape.lineTo(wx(botEndX), -half);
  shape.lineTo(wx(stern.x), -half);
  shape.closePath();
  return shape;
}

function buildShipModel(vesselConfig, report) {
  const geo = computeGeometry(vesselConfig);
  const group = new THREE.Group();
  const pickables = [];
  if (!geo) return { group, pickables, geo: null };
  const unit = vesselConfig.display?.unit || "M³";
  const decimals = vesselConfig.display?.decimals ?? 1;

  // 각 Tank의 배치를 먼저 전부 계산해둔다 -- 갑판 절개 구멍을 "Tank들이 실제로 차지하는 범위"
  // 기준으로 만들어야 하기 때문에(선체 외곽선의 gridTopY/gridBottomY가 아니라), 선체/갑판을
  // 만들기 전에 Tank 쪼가 필요하다.
  const placements = geo.tanks.map(tank => {
    const x0 = geo.wx(tank.position.x), x1 = geo.wx(tank.position.x + tank.size.w);
    const w = Math.abs(x1 - x0);
    const d = Math.abs(geo.wz(tank.position.y + tank.size.h) - geo.wz(tank.position.y)); // 크기는 기존 방식 그대로(불변)
    const cx = (x0 + x1) / 2;
    const zResult = tankCenterZ(tank, geo);
    const yResult = tankCenterY(tank, geo);
    return { tank, x0, x1, w, d, cx, cz: zResult.z, cy: yResult.y, precisePosition: zResult.precise && yResult.precise };
  });

  const shape = buildHullOutlineShape(geo);
  const hullGeom = new THREE.ExtrudeGeometry(shape, {
    depth: geo.hullDepth, bevelEnabled: true,
    bevelThickness: geo.hullDepth * 0.06, bevelSize: geo.hullWidth * 0.02, bevelSegments: 2, curveSegments: 1
  });
  hullGeom.rotateX(-Math.PI / 2);
  const hullMesh = new THREE.Mesh(hullGeom, new THREE.MeshStandardMaterial({
    color: 0x9fb3c4, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, roughness: 0.9
  }));
  group.add(hullMesh);
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(hullGeom), new THREE.LineBasicMaterial({ color: 0x1c2733 })));

  // 갑판판 + Tank 영역 위쪽만 절개된 구멍 -- 그 구멍으로 안의 Tank가 내려다보임. 구멍 범위는
  // (선체 폭이 아니라) 실제로 배치된 Tank들의 X/Z 범위를 기준으로 잡는다 -- precise 모드에서는
  // 선체 폭(실측 Beam)이 Tank들이 차지하는 범위보다 넓을 수 있기 때문(그 경우 구멍은 Tank
  // 범위만큼만 뚫려야 자연스러움).
  const margin = geo.hullWidth * 0.03;
  const halfWidth = geo.hullWidth / 2;
  // precise 모드에서는 Tank 중심(cz, 실측 TCG)과 Tank 폭(d, 기존 픽셀 기반 크기)이 서로 다른
  // 소스에서 나오기 때문에, 둘을 더한 값이 이론상 실측 선체 폭(halfWidth)을 넘어설 수 있다 --
  // 구멍이 갑판(외곽선) 밖으로 나가면 ShapeGeometry가 깨져서(구멍이 외곽보다 커짐) 아무것도
  // 렌더링되지 않으므로, 항상 외곽 안쪽에 머물도록 clamp한다(정상적인 경우는 clamp가 아무
  // 영향을 주지 않음).
  const hx0 = Math.max(geo.wx(geo.topEndX) + margin, Math.min(...placements.map(p => p.x0)) - margin);
  const hx1 = Math.min(geo.wx(geo.maxX) - margin, Math.max(...placements.map(p => p.x1)) + margin);
  const hz0 = Math.max(-halfWidth + margin, Math.min(...placements.map(p => p.cz - p.d / 2)) - margin);
  const hz1 = Math.min(halfWidth - margin, Math.max(...placements.map(p => p.cz + p.d / 2)) + margin);
  const hole = new THREE.Path();
  // buildHullOutlineShape와 동일한 부호 규약(local Y = -world Z)을 맞춰야 한다.
  hole.moveTo(hx0, -hz0); hole.lineTo(hx1, -hz0); hole.lineTo(hx1, -hz1); hole.lineTo(hx0, -hz1); hole.closePath();
  const deckShape = buildHullOutlineShape(geo);
  deckShape.holes.push(hole);
  const deckGeom = new THREE.ShapeGeometry(deckShape);
  deckGeom.rotateX(-Math.PI / 2);
  deckGeom.translate(0, geo.hullDepth, 0);
  group.add(new THREE.Mesh(deckGeom, new THREE.MeshStandardMaterial({ color: 0x2b3a48, side: THREE.DoubleSide, roughness: 0.85 })));

  const robByTankId = new Map(report.rob.map(r => [r.tankId, r]));
  for (const { tank, w, d, cx, cz, cy, precisePosition } of placements) {
    const entry = robByTankId.get(tank.id);
    const capacity = typeof tank.capacity === "number" ? tank.capacity : null;
    const fillRatio = capacity && entry && typeof entry.rob === "number" ? Math.max(0, Math.min(1, entry.rob / capacity)) : 0;
    const boxBottom = cy - geo.tankHeight / 2; // 실측 VCG 중심 기준으로 재정의된 "박스 바닥"

    // Tank 뼈대 (전체 Capacity 부피 -- 반투명 유리 상자, 클릭 판정 대상)
    const shellGeom = new THREE.BoxGeometry(w, geo.tankHeight, d);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b3a48 });
    const shellMesh = new THREE.Mesh(shellGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false }));
    shellMesh.position.set(cx, cy, cz);
    shellMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(shellGeom), edgeMat));
    shellMesh.userData = {
      tankId: tank.id, name: tank.name, capacity, grade: entry?.grade ?? null,
      rob: entry && typeof entry.rob === "number" ? entry.rob : null,
      // "실측"은 principalParticulars 유무가 아니라 이 Tank 자체의 cg가 확인되고(verified===true)
      // 있어야만 성립 -- Tank 단위로 엄격히 판정.
      positionVerified: !!(tank.cg && tank.cg.verified === true && precisePosition),
      edgeMaterial: edgeMat, liquidMaterial: null
    };
    group.add(shellMesh);
    pickables.push(shellMesh);

    // fillRatio(ROB/Capacity, 시각적 표시용 -- 실제 액면 높이 아님)만큼 채운 블록 -- 박스 바닥에서부터 위로
    if (fillRatio > 0) {
      const fillH = Math.max(0.02, geo.tankHeight * fillRatio);
      const fillGeom = new THREE.BoxGeometry(w * 0.9, fillH, d * 0.9);
      const fillMat = new THREE.MeshStandardMaterial({ color: colorFor(entry?.grade), roughness: 0.75, metalness: 0.05 });
      const fillMesh = new THREE.Mesh(fillGeom, fillMat);
      fillMesh.position.set(cx, boxBottom + fillH / 2, cz);
      group.add(fillMesh);
      shellMesh.userData.liquidMaterial = fillMat;
    }

    // 이름/Grade/ROB 라벨 -- 갑판 절개 구멍을 통해 위에서 보임 (실제 3D 텍스트 대신 캔버스
    // 텍스처 평면 -- 폰트 로딩 없이 2D와 같은 정보를 가볍게 표시)
    const robText = entry && typeof entry.rob === "number" ? `${entry.rob.toFixed(decimals)} ${unit}` : "N/A";
    const labelTexture = makeLabelTexture([tank.name, `CAP ${capacity ?? "N/A"}`, `${entry?.grade || "N/A"}  ${robText}`]);
    const labelGeom = new THREE.PlaneGeometry(w * 0.88, d * 0.88);
    const labelMesh = new THREE.Mesh(labelGeom, new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, depthWrite: false }));
    labelMesh.rotateX(-Math.PI / 2);
    labelMesh.position.set(cx, geo.hullDepth + 0.02, cz);
    group.add(labelMesh);
  }
  return { group, pickables, geo };
}

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
  });
}

function resizeContext(ctx) {
  const el = ctx.containerEl;
  const w = Math.max(200, el.clientWidth);
  const h = Math.max(320, Math.round(w * 0.55));
  ctx.renderer.setSize(w, h, false);
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.render(ctx.scene, ctx.camera);
}

function frameCamera(ctx, geo) {
  const length = geo ? Math.max(geo.length, 1) : 10;
  const depth = geo ? geo.hullDepth : length * 0.2;
  const target = new THREE.Vector3(length / 2, depth * 0.4, 0);
  ctx.camera.position.set(target.x - length * 0.55, length * 0.5, length * 0.85);
  ctx.controls.target.copy(target);
  ctx.controls.update();
}

function ensureContext(containerEl) {
  let ctx = contexts.get(containerEl);
  if (ctx) return ctx;

  containerEl.style.position = "relative";
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  containerEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef1f5);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI * 0.48; // 선체 바닥이 보이는 각도까지는 회전 못 하게 제한
  controls.minDistance = 1;
  controls.maxDistance = 500;
  controls.addEventListener("change", () => renderer.render(scene, camera));

  scene.add(new THREE.HemisphereLight(0xdce7f2, 0x4b5560, 0.7));
  const dirLight = new THREE.DirectionalLight(0xfff6e8, 0.85);
  dirLight.position.set(6, 10, 6);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const infoPanel = document.createElement("div");
  infoPanel.className = "tank3d-info-panel";
  infoPanel.style.display = "none";
  containerEl.appendChild(infoPanel);

  ctx = { renderer, scene, camera, controls, containerEl, infoPanel, group: null, pickables: [], selected: null, vesselId: null };
  contexts.set(containerEl, ctx);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener("click", (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    clearSelection(ctx);
    const hits = raycaster.intersectObjects(ctx.pickables, false);
    if (hits.length > 0) {
      selectTank(ctx, hits[0].object);
    } else {
      infoPanel.style.display = "none";
    }
    renderer.render(scene, camera);
  });

  new ResizeObserver(() => resizeContext(ctx)).observe(containerEl);

  return ctx;
}

function selectTank(ctx, mesh) {
  ctx.selected = mesh;
  mesh.userData.edgeMaterial.color.set(0xffcc33);
  if (mesh.userData.liquidMaterial) {
    mesh.userData.liquidMaterial.emissive = mesh.userData.liquidMaterial.color.clone();
    mesh.userData.liquidMaterial.emissiveIntensity = 0.4;
  }
  const { name, capacity, grade, rob, positionVerified } = mesh.userData;
  const unit = ctx.unit || "M³";
  const decimals = ctx.decimals ?? 1;
  ctx.infoPanel.innerHTML =
    `<strong>${name}</strong>` +
    `<div>Capacity: ${capacity != null ? capacity : "N/A"} ${unit}</div>` +
    `<div>Grade: ${grade || "N/A"}</div>` +
    `<div>ROB: ${rob != null ? rob.toFixed(decimals) : "N/A"} ${unit}</div>` +
    `<div>Position: ${positionVerified ? "실측" : "근사"}</div>`;
  ctx.infoPanel.style.display = "block";
}

function clearSelection(ctx) {
  if (!ctx.selected) return;
  ctx.selected.userData.edgeMaterial.color.set(0x2b3a48);
  if (ctx.selected.userData.liquidMaterial) ctx.selected.userData.liquidMaterial.emissiveIntensity = 0;
  ctx.selected = null;
}

export function render3D(vesselConfig, report, containerEl) {
  if (!containerEl) return;
  const ctx = ensureContext(containerEl);
  ctx.unit = vesselConfig.display?.unit;
  ctx.decimals = vesselConfig.display?.decimals;

  if (ctx.group) { ctx.scene.remove(ctx.group); disposeGroup(ctx.group); }
  clearSelection(ctx);
  ctx.infoPanel.style.display = "none";

  const { group, pickables, geo } = buildShipModel(vesselConfig, report);
  ctx.scene.add(group);
  ctx.group = group;
  ctx.pickables = pickables;

  const precisionNote = document.getElementById("view-3d-precision-note");
  if (precisionNote) {
    precisionNote.textContent = geo?.precise
      ? "이 선박은 Capacity Plan에 기재된 실제 Beam/Depth 데이터를 사용합니다 (Tank별 위치는 클릭 시 확인 가능)."
      : "이 선박은 실측 Beam/Depth 데이터가 없어 근사 비율로 표시됩니다.";
  }

  if (!geo) {
    ctx.infoPanel.textContent = "3D 뷰를 표시할 Tank 데이터가 부족합니다 (Port/Starboard 양쪽에 표시 대상 Tank가 필요).";
    ctx.infoPanel.style.display = "block";
  }

  const isNewVessel = ctx.vesselId !== vesselConfig.vesselId;
  ctx.vesselId = vesselConfig.vesselId;
  resizeContext(ctx);
  if (isNewVessel) frameCamera(ctx, geo);
  ctx.renderer.render(ctx.scene, ctx.camera);
}
