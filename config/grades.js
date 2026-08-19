// Grade -> 표시 스타일 매핑. 새 Grade가 생기면 여기에 항목만 추가하면 됨 (렌더러/검증 로직 수정 불필요).
// 중유(HFO 계열: VLSFO/HFO/HSFO/LSFO/LSHFO)는 주황~갈색, 경유(가스오일 계열: MGO/LSMGO)는
// 완전히 다른 청색 계열로 통일한다 -- Grade별로 색을 잘게 나누지 않고 "연료유 vs 경유" 두 계열만
// 색으로 구분한다.
const FO_STYLE = { fill: "#c97a3d", text: "#2b1400" };
const LSMGO_STYLE = { fill: "#f2e2a0", text: "#4a3c00" };
const GRADE_PALETTE = {
  VLSFO: { label: "VLSFO", ...FO_STYLE },
  HFO:   { label: "HFO",   ...FO_STYLE },
  HSFO:  { label: "HSFO",  ...FO_STYLE },
  LSFO:  { label: "LSFO",  ...FO_STYLE },
  LSHFO: { label: "LSHFO", ...FO_STYLE },
  MGO:   { label: "MGO",   ...LSMGO_STYLE },
  LSMGO: { label: "LSMGO", ...LSMGO_STYLE }
};

// Config에 없는 Grade가 들어오면 사용하는 기본 스타일 (프로그램이 깨지지 않도록)
const GRADE_FALLBACK = { fill: "#cccccc", text: "#333333" };
