// ============================================================
// Validation Layer (bunker-plan-console.html 아티팩트에서 그대로 이식)
// ============================================================
// 화면에 표시할 Tank 판단 기준 (용량이 아니라 목적/구조 기준):
// 1) 선체 외판에 붙어 있고(onShell) 2) Storage Tank이며(role) 3) 일정 용량 이상인 Tank만 표시.
// Sett./Serv./Overflow/Drain 같은 목적성 Tank나, Storage Tank라도 Wing Tank 밑 이중저처럼
// 외판에 붙어있지 않은 Tank는 용량과 무관하게 항상 숨긴다. 합계에는 숨겨진 Tank도 포함된다.
function isTankVisible(vesselConfig, tank) {
  const minVisibleCapacity = vesselConfig.display?.minVisibleCapacity ?? 100;
  return tank.onShell === true
    && tank.role === "STORAGE"
    && typeof tank.capacity === "number"
    && tank.capacity >= minVisibleCapacity;
}

function validateReport(vesselConfig, report) {
  const blocking = [];
  const warnings = [];
  const tanksById = new Map(vesselConfig.tanks.map(t => [t.id, t]));
  const seenTankIds = new Set();

  for (const entry of report.rob) {
    if (seenTankIds.has(entry.tankId)) { blocking.push(`중복된 Tank 데이터: ${entry.tankId}`); continue; }
    seenTankIds.add(entry.tankId);
    const tank = tanksById.get(entry.tankId);
    if (!tank) { blocking.push(`Configuration에 존재하지 않는 Tank: ${entry.tankId}`); continue; }
    if (!entry.grade) blocking.push(`Grade 누락: ${tank.name}`);
    if (typeof entry.rob !== "number" || Number.isNaN(entry.rob)) blocking.push(`ROB가 숫자가 아님: ${tank.name}`);
    else if (entry.rob < 0) blocking.push(`ROB가 음수: ${tank.name}`);
    else if (typeof tank.capacity === "number" && entry.rob > tank.capacity) {
      // Bunker Report의 실측 Sounding/Ullage 값은 Capacity Plan의 명목 100% 용량을 트림/리스트
      // 보정값 등으로 인해 미세하게(대략 3% 이내) 넘을 수 있다 -- 이는 오류가 아니라 실측 데이터의
      // 정상적인 오차 범위이므로 화면에 별도로 알리지 않고 조용히 허용하고(게이지는 100%로 표시),
      // 그보다 크게 벗어나면(입력 실수 가능성) 중단시킨다.
      const overRatio = entry.rob / tank.capacity;
      if (overRatio > 1.03) blocking.push(`ROB(${entry.rob})가 Capacity(${tank.capacity})를 크게 초과: ${tank.name}`);
    }
  }
  for (const tank of vesselConfig.tanks) {
    if (!seenTankIds.has(tank.id) && isTankVisible(vesselConfig, tank)) warnings.push(`ROB 데이터 없음 (N/A로 표시됨): ${tank.name}`);
  }
  return { blocking, warnings };
}
