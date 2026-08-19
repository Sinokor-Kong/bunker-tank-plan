#!/usr/bin/env node
// 1회성 마이그레이션: 기존 Claude Artifact(bunker-plan-console.html)에 하드코딩된 VESSELS
// 배열을 이 사이트의 data/vessels/*.json + data/reports/*/*.json + data/index.json 으로 변환한다.
// sourceHash는 "legacy"로 표시해둔다 -- 나중에 실제 Capacity Plan PDF가 한 번이라도 다시
// 업로드되면 정상적인 해시로 자동 갱신된다.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.resolve(ROOT, "../bunker-tank-plan/artifact/bunker-plan-console.html");
const DATA_DIR = path.join(ROOT, "data");

function sanitizeSlug(reportDate) {
  return reportDate.replace(/[^0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function main() {
  const html = fs.readFileSync(ARTIFACT_PATH, "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("아티팩트에서 <script> 블록을 찾지 못했습니다.");
  const scriptText = match[1];

  const sandbox = { window: { addEventListener: () => {} }, console };
  vm.createContext(sandbox);
  // 스크립트의 VESSELS는 top-level const라 vm 컨텍스트 객체(sandbox)의 프로퍼티로 노출되지
  // 않는다 (var/함수 선언만 노출됨) -- var 바인딩으로 한 번 더 옮겨 담아서 꺼낸다.
  vm.runInContext(scriptText + "\nvar __MIGRATE_EXPORT__ = VESSELS;", sandbox, { filename: "bunker-plan-console.html" });

  const VESSELS = sandbox.__MIGRATE_EXPORT__;
  if (!Array.isArray(VESSELS)) throw new Error("VESSELS 배열을 추출하지 못했습니다.");

  fs.mkdirSync(path.join(DATA_DIR, "vessels"), { recursive: true });
  const index = [];

  for (const entry of VESSELS) {
    const config = { ...entry.config, sourceHash: "legacy", sourceFile: null };
    fs.writeFileSync(path.join(DATA_DIR, "vessels", `${config.vesselId}.json`), JSON.stringify(config, null, 2));

    const reportsMeta = [];
    fs.mkdirSync(path.join(DATA_DIR, "reports", config.vesselId), { recursive: true });
    for (const report of entry.reports) {
      const slug = sanitizeSlug(report.reportDate);
      fs.writeFileSync(path.join(DATA_DIR, "reports", config.vesselId, `${slug}.json`), JSON.stringify(report, null, 2));
      reportsMeta.push({ slug, reportDate: report.reportDate });
    }
    index.push({ vesselId: config.vesselId, vesselName: config.vesselName, reports: reportsMeta });
    console.log(`[migrate] ${config.vesselId}: Tank ${config.tanks.length}개, Report ${reportsMeta.length}건`);
  }

  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log(`[migrate] 완료: 선박 ${index.length}척 -> data/index.json`);
}

main();
