// ============================================================
// Data Table -- bunker-plan-console.html 아티팩트에서 그대로 이식.
// ============================================================
function renderDataTable(vesselConfig, report, containerEl) {
  containerEl.innerHTML = "";
  const decimals = vesselConfig.display?.decimals ?? 1;
  const unit = vesselConfig.display?.unit ?? "MT";
  const missingLabel = vesselConfig.display?.missingLabel ?? "N/A";
  const robByTankId = new Map(report.rob.map(r => [r.tankId, r]));

  const rows = vesselConfig.tanks.filter(t => isTankVisible(vesselConfig, t)).map(tank => {
    const entry = robByTankId.get(tank.id);
    return { tank, grade: entry?.grade, rob: entry?.rob };
  });

  const table = document.createElement("table");
  table.className = "rob-table";
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th>Tank</th><th>Grade</th><th>Capacity (${unit})</th><th>ROB (${unit})</th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const gradeStyle = (row.grade && GRADE_PALETTE[row.grade]) || GRADE_FALLBACK;
    tr.innerHTML = `
      <td>${row.tank.name}</td>
      <td style="background:${gradeStyle.fill}; color:${gradeStyle.text}; font-weight:700;">${row.grade || missingLabel}</td>
      <td class="num">${typeof row.tank.capacity === "number" ? row.tank.capacity : "-"}</td>
      <td class="num">${typeof row.rob === "number" ? row.rob.toFixed(decimals) : missingLabel}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const totalCapacity = rows.reduce((sum, r) => sum + (typeof r.tank.capacity === "number" ? r.tank.capacity : 0), 0);
  const totalRob = rows.reduce((sum, r) => sum + (r.tank.excludeFromTotal ? 0 : (r.rob || 0)), 0);
  tfoot.innerHTML = `<tr><td>TOTAL</td><td></td><td class="num">${totalCapacity.toFixed(decimals)}</td><td class="num">${totalRob.toFixed(decimals)}</td></tr>`;
  table.appendChild(tfoot);
  containerEl.appendChild(table);
}
