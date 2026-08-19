// ============================================================
// Rendering Layer (SVG Tank Plan) -- bunker-plan-console.html 아티팩트에서 그대로 이식.
// ============================================================
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}
function formatRob(value, decimals) { return typeof value === "number" ? value.toFixed(decimals) : null; }
function visibleTanks(vesselConfig) { return vesselConfig.tanks.filter(t => isTankVisible(vesselConfig, t)); }
function wrapText(text, maxWidth, charWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length * charWidth > maxWidth && current) { lines.push(current); current = word; }
    else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

// Tank 왼쪽에 그리는 세로 Capacity Gauge: 전체 높이 = Capacity 100%, 초록 채움 = 현재 ROB 비율.
const GAUGE_W = 16, GAUGE_MARGIN = 6;
function gaugeReservedWidth(tank) {
  return typeof tank.capacity === "number" && tank.capacity > 0 ? GAUGE_MARGIN * 2 + GAUGE_W : 0;
}
function drawCapacityGauge(svg, rect, tank, entry) {
  if (typeof tank.capacity !== "number" || tank.capacity <= 0) return;
  const { x, y, h } = rect;
  const gx = x + GAUGE_MARGIN, gy = y + GAUGE_MARGIN, gh = h - GAUGE_MARGIN * 2;
  const rob = entry?.rob;
  const frac = typeof rob === "number" ? Math.max(0, Math.min(1, rob / tank.capacity)) : 0;

  svg.appendChild(svgEl("rect", { x: gx, y: gy, width: GAUGE_W, height: gh, fill: "rgba(255,255,255,0.6)", stroke: "none" }));
  if (frac > 0) {
    const fillH = gh * frac;
    svg.appendChild(svgEl("rect", { x: gx, y: gy + (gh - fillH), width: GAUGE_W, height: fillH, fill: "#2f9e5c", stroke: "none" }));
  }
  // 50% 눈금선 -- Capacity 대비 대략적인 잔량 수준을 한눈에 보여줌
  svg.appendChild(svgEl("line", { x1: gx, y1: gy + gh / 2, x2: gx + GAUGE_W, y2: gy + gh / 2, stroke: "#2b3a48", "stroke-width": 0.75, "stroke-dasharray": "2 2" }));
  svg.appendChild(svgEl("rect", { x: gx, y: gy, width: GAUGE_W, height: gh, fill: "none", stroke: "#2b3a48", "stroke-width": 1.25 }));
}

function drawTankText(svg, rect, tank, entry, opts) {
  const { decimals, unit, missingLabel } = opts;
  const { x, y, w, h } = rect;
  const grade = entry?.grade;
  const style = (grade && GRADE_PALETTE[grade]) || GRADE_FALLBACK;
  const fontStack = 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace';

  // Gauge가 차지하는 폭만큼 제외한 나머지 영역에 텍스트를 중앙 정렬한다.
  const reserved = gaugeReservedWidth(tank);
  const tx = x + reserved, tw = w - reserved;
  const cx = tx + tw / 2;

  const compact = h < 60;
  // 폭/높이 중 더 빠듯한 쪽을 기준으로 스케일을 잡아서, 박스가 넉넉하면 글자를 최대한 키우고
  // 좁으면 그만큼만 줄인다 (고정 임계값이 아니라 실측 기준 -- 박스 밖으로 튀어나오지 않게).
  const widthScale = Math.min(1, tw / 150);
  const heightScale = Math.min(1, h / 130);
  const scale = Math.min(widthScale, heightScale);

  let nameFontSize = Math.max(10, Math.round((compact ? 15 : 20) * scale));
  let charWidth = nameFontSize * 0.62;
  let nameLines = tank.name.length * charWidth > (tw - 8) ? wrapText(tank.name, tw - 8, charWidth) : [tank.name];
  // 이름이 2줄 이상으로 줄바꿈되면 이름 글씨만 한 단계 줄여서 다시 줄바꿈한다 -- 그래야 Capacity 줄이
  // 항상 표시될 공간이 남는다 (Capacity를 생략하지 않고 항상 보이게 하기 위함).
  if (nameLines.length > 1) {
    nameFontSize = Math.max(9, Math.round(nameFontSize * 0.72));
    charWidth = nameFontSize * 0.62;
    nameLines = tank.name.length * charWidth > (tw - 8) ? wrapText(tank.name, tw - 8, charWidth) : [tank.name];
  }
  const nameStartY = y + (compact ? 18 : 26);
  nameLines.forEach((line, i) => {
    svg.appendChild(svgEl("text", { x: cx, y: nameStartY + i * (nameFontSize + 4), "text-anchor": "middle", "font-size": nameFontSize, "font-weight": "700", "font-family": fontStack, fill: style.text }));
    svg.lastChild.textContent = line;
  });

  const gradeFontSize = Math.max(10, Math.round((compact ? 14 : 18) * scale));
  const robFontSize = Math.max(11, Math.round((compact ? 16 : 24) * scale));
  const gradeY = y + h - (compact ? 21 : 36);

  const showCapacity = typeof tank.capacity === "number" && h >= 78;
  if (showCapacity) {
    // Capacity 줄 위치는 이름 블록 바로 아래로 계산하되, Grade 줄과 절대 겹치지 않도록 안전 거리를 둔다.
    const naturalY = nameStartY + nameLines.length * (nameFontSize + 4) + 13;
    const capacityY = Math.min(naturalY, gradeY - 16);
    svg.appendChild(svgEl("text", { x: cx, y: capacityY, "text-anchor": "middle", "font-size": Math.max(10, Math.round(18 * scale)), "font-family": fontStack, fill: style.text }));
    svg.lastChild.textContent = `CAP ${tank.capacity}`;
  }

  const robText = entry ? `${formatRob(entry.rob, decimals)} ${unit}` : missingLabel;
  svg.appendChild(svgEl("text", { x: cx, y: gradeY, "text-anchor": "middle", "font-size": gradeFontSize, "font-family": fontStack, fill: style.text }));
  svg.lastChild.textContent = grade || missingLabel;

  svg.appendChild(svgEl("text", { x: cx, y: y + h - (compact ? 6 : 10), "text-anchor": "middle", "font-size": robFontSize, "font-weight": "700", "font-family": fontStack, fill: style.text }));
  svg.lastChild.textContent = robText;
}

// 화면에 실제로 그려지는 Tank들의 경계선(x좌표) 목록을 보고, 중앙값보다 지나치게 넓은 구간은
// 압축하고 특정 절대 폭보다 지나치게 좁은 구간은 넓혀주는 X좌표 재매핑 함수를 만든다. Tank
// 하나가 유난히 길어서 같은 줄의 다른 Tank를 압도하거나, 반대로 유난히 좁아서 글자가 빽빽해
// 보이는 문제를, 선박마다 값을 따로 맞추지 않고 렌더링 시점에 자동으로 해결하기 위함이다.
// Port/Starboard를 가리지 않고 전체 Tank의 경계선을 한 번에 모아서 처리하므로, 같은 Frame
// 경계를 공유하는 두 줄의 끝단은 조정 후에도 항상 정확히 일치한다.
function buildAdaptiveXRemap(tanks) {
  const boundarySet = new Set();
  for (const t of tanks) { boundarySet.add(t.position.x); boundarySet.add(t.position.x + t.size.w); }
  const boundaries = [...boundarySet].sort((a, b) => a - b);
  if (boundaries.length < 3) return (x) => x; // 구간이 1개뿐이면 비교 대상이 없어 조정할 필요 없음
  const segmentWidths = [];
  for (let i = 0; i < boundaries.length - 1; i++) segmentWidths.push(boundaries[i + 1] - boundaries[i]);
  const sortedWidths = [...segmentWidths].sort((a, b) => a - b);
  const median = sortedWidths[Math.floor(sortedWidths.length / 2)];
  const CAP_MULTIPLIER = 2.2, MIN_CAP = 220;
  const cap = Math.max(MIN_CAP, median * CAP_MULTIPLIER);
  // 절대 최소 폭(가로 Gauge 폭 + 여백을 빼고도 글자가 정상 크기로 들어갈 수 있는 최소 기준) --
  // 다른 선박들의 가장 좁은 Tank(120px 이상)에는 영향이 없고, 그보다 훨씬 좁은 경우만 넓힌다.
  const MIN_SEGMENT_W = 115;
  const remap = new Map([[boundaries[0], boundaries[0]]]);
  let cursor = boundaries[0];
  segmentWidths.forEach((w, i) => {
    cursor += Math.min(Math.max(w, MIN_SEGMENT_W), cap);
    remap.set(boundaries[i + 1], cursor);
  });
  return (x) => remap.get(x) ?? x;
}

function renderTankPlan(vesselConfig, report, containerEl) {
  containerEl.innerHTML = "";
  const robByTankId = new Map(report.rob.map(r => [r.tankId, r]));
  const decimals = vesselConfig.display?.decimals ?? 1;
  const unit = vesselConfig.display?.unit ?? "MT";
  const missingLabel = vesselConfig.display?.missingLabel ?? "N/A";
  const hull = vesselConfig.hull;
  const visible = visibleTanks(vesselConfig);
  const rawTanks = visible.filter(t => !t.nestedIn);
  const xRemap = buildAdaptiveXRemap(rawTanks);
  // vesselConfig 원본을 직접 건드리면 다른 선박으로 전환했다가 되돌아왔을 때 압축이 누적으로
  // 어긋나므로, 반드시 복제한 뒤 그 복제본의 좌표만 재매핑한다.
  const tanks = rawTanks.map(t => {
    const newX = xRemap(t.position.x), newRight = xRemap(t.position.x + t.size.w);
    return { ...t, position: { ...t.position, x: newX }, size: { ...t.size, w: newRight - newX } };
  });
  const nestedByParent = new Map();
  for (const t of visible.filter(t => t.nestedIn)) {
    if (!nestedByParent.has(t.nestedIn)) nestedByParent.set(t.nestedIn, []);
    nestedByParent.get(t.nestedIn).push(t);
  }

  // Port 그룹과 Starboard 그룹의 최소 Frame이 서로 다를 수 있어서, 위/아래 쐐기 끝점을 하나의
  // 공통 X좌표가 아니라 "그 줄(Port/Starboard)에서 가장 선미 쪽 Tank"에 각각 맞춰야 한다.
  const wedgeCenterlineY = hull?.centerlineY ?? (Math.min(...tanks.map(t => t.position.y)) + Math.max(...tanks.map(t => t.position.y + t.size.h))) / 2;
  const topRowTanks = tanks.filter(t => t.position.y + t.size.h / 2 < wedgeCenterlineY);
  const bottomRowTanks = tanks.filter(t => t.position.y + t.size.h / 2 >= wedgeCenterlineY);
  const gridTopY = Math.min(...topRowTanks.map(t => t.position.y));
  const gridBottomY = Math.max(...bottomRowTanks.map(t => t.position.y + t.size.h));
  const topEnd = [Math.min(...topRowTanks.map(t => t.position.x)), gridTopY];
  const botEnd = [Math.min(...bottomRowTanks.map(t => t.position.x)), gridBottomY];

  const hullXs = hull ? [hull.sternLine.x, topEnd[0], botEnd[0]] : [];
  const hullYs = hull ? [hull.sternLine.yTop, hull.sternLine.yBottom, gridTopY, gridBottomY] : [];
  const maxX = Math.max(...tanks.map(t => t.position.x + t.size.w), ...hullXs) + 60;
  const maxY = Math.max(...tanks.map(t => t.position.y + t.size.h), ...hullYs) + 50;
  const minY = Math.min(...tanks.map(t => t.position.y), ...hullYs) - 40;

  const svg = svgEl("svg", { viewBox: `0 ${minY} ${maxX} ${maxY - minY}`, width: "100%", style: "max-width:100%; height:auto; background:#ffffff;" });
  const fontStack = 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace';

  if (hull) {
    const stern = hull.sternLine;
    // 선체 외판(Shell) 표현이므로 Tank 박스 테두리(1.5)보다 뚜렷하게 굵은 선으로 그린다.
    const hullStroke = { stroke: "#1c2733", "stroke-width": 4.5, "stroke-linecap": "round" };
    svg.appendChild(svgEl("line", { x1: stern.x, y1: stern.yTop, x2: stern.x, y2: stern.yBottom, ...hullStroke }));
    svg.appendChild(svgEl("line", { x1: stern.x, y1: stern.yTop, x2: topEnd[0], y2: topEnd[1], ...hullStroke }));
    svg.appendChild(svgEl("line", { x1: stern.x, y1: stern.yBottom, x2: botEnd[0], y2: botEnd[1], ...hullStroke }));

    const tanksById = new Map(vesselConfig.tanks.map(t => [t.id, t]));
    const gradeTotals = {};
    for (const entry of report.rob) {
      const tank = tanksById.get(entry.tankId);
      if (!tank || tank.excludeFromTotal || !isTankVisible(vesselConfig, tank)) continue;
      gradeTotals[entry.grade] = (gradeTotals[entry.grade] || 0) + entry.rob;
    }
    const grades = Object.keys(gradeTotals);
    const boxW = 200, rowH = 26, boxH = 38 + grades.length * rowH;
    const wedgeRightX = Math.min(topEnd[0], botEnd[0]);
    const boxX = (stern.x + wedgeRightX) / 2 - boxW / 2;
    const boxY = hull.centerlineY - boxH / 2;

    svg.appendChild(svgEl("rect", { x: boxX, y: boxY, width: boxW, height: boxH, fill: "#fafafa", stroke: "#2b3a48", "stroke-width": 1.5, rx: 3 }));
    svg.appendChild(svgEl("line", { x1: boxX, y1: boxY + 36, x2: boxX + boxW, y2: boxY + 36, stroke: "#2b3a48", "stroke-width": 1 }));
    svg.appendChild(svgEl("text", { x: boxX + boxW / 2, y: boxY + 24, "text-anchor": "middle", "font-size": 13, "font-weight": "700", "font-family": fontStack, fill: "#16212c", "letter-spacing": "0.06em" }));
    svg.lastChild.textContent = "TOTAL BUNKER ROB";
    grades.forEach((g, i) => {
      const ry = boxY + 36 + (i + 0.68) * rowH;
      svg.appendChild(svgEl("text", { x: boxX + 14, y: ry, "font-size": 15, "font-family": fontStack, fill: "#16212c" }));
      svg.lastChild.textContent = g;
      svg.appendChild(svgEl("text", { x: boxX + boxW - 14, y: ry, "text-anchor": "end", "font-size": 15, "font-weight": "700", "font-family": fontStack, fill: "#16212c" }));
      svg.lastChild.textContent = `${formatRob(gradeTotals[g], decimals)} ${unit}`;
    });
  }

  const centerlineY = hull?.centerlineY ?? (minY + maxY) / 2;
  for (const group of vesselConfig.groups || []) {
    const groupTanks = tanks.filter(t => t.group === group.id);
    if (groupTanks.length === 0) continue;
    const left = Math.min(...groupTanks.map(t => t.position.x));
    const right = Math.max(...groupTanks.map(t => t.position.x + t.size.w));
    const top = Math.min(...groupTanks.map(t => t.position.y));
    const bottom = Math.max(...groupTanks.map(t => t.position.y + t.size.h));
    const groupCenter = (top + bottom) / 2;
    const labelY = groupCenter < centerlineY ? top - 16 : bottom + 26;
    svg.appendChild(svgEl("text", { x: (left + right) / 2, y: labelY, "text-anchor": "middle", "font-size": 15, "font-weight": "700", "font-family": fontStack, fill: "#3c4b58", "letter-spacing": "0.08em" }));
    svg.lastChild.textContent = group.label;
  }

  const textOpts = { decimals, unit, missingLabel };
  for (const tank of tanks) {
    const { x, y } = tank.position;
    const { w, h } = tank.size;
    const children = nestedByParent.get(tank.id) || [];
    const nestedTotalH = children.reduce((sum, c) => sum + c.size.h, 0);
    const ownH = h - nestedTotalH;
    const ownEntry = robByTankId.get(tank.id);
    const ownStyle = (ownEntry?.grade && GRADE_PALETTE[ownEntry.grade]) || GRADE_FALLBACK;

    svg.appendChild(svgEl("rect", { x, y, width: w, height: ownH, fill: ownStyle.fill, stroke: "none" }));
    let cursorY = y + ownH;
    for (const child of children) {
      const childEntry = robByTankId.get(child.id);
      const childStyle = (childEntry?.grade && GRADE_PALETTE[childEntry.grade]) || GRADE_FALLBACK;
      svg.appendChild(svgEl("rect", { x, y: cursorY, width: w, height: child.size.h, fill: childStyle.fill, stroke: "none" }));
      svg.appendChild(svgEl("line", { x1: x, y1: cursorY, x2: x + w, y2: cursorY, stroke: "#fff", "stroke-width": 1.5 }));
      cursorY += child.size.h;
    }
    svg.appendChild(svgEl("rect", { x, y, width: w, height: h, fill: "none", stroke: "#2b3a48", "stroke-width": 1.5, rx: 4 }));

    drawCapacityGauge(svg, { x, y, w, h: ownH }, tank, ownEntry);
    drawTankText(svg, { x, y, w, h: ownH }, tank, ownEntry, textOpts);
    cursorY = y + ownH;
    for (const child of children) {
      drawCapacityGauge(svg, { x, y: cursorY, w, h: child.size.h }, child, robByTankId.get(child.id));
      drawTankText(svg, { x, y: cursorY, w, h: child.size.h }, child, robByTankId.get(child.id), textOpts);
      cursorY += child.size.h;
    }
  }
  containerEl.appendChild(svg);
}
