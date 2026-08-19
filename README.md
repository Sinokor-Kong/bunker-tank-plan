# Bunker Tank Plan Console

VLCC 선단의 Bunker 연료 Tank 배치와 ROB(Remaining On Board)를 보여주는 정적 사이트.
기존 Claude Artifact 버전을 대체하며, 신규 선박/ROB Report는 사이트에서 파일을 드래그하면
GitHub Actions + Claude API가 자동으로 분석해 반영한다.

## 최초 설정 (1회)

1. **GitHub Pages 활성화**: 저장소 Settings → Pages → Source를 `main` 브랜치 / `/ (root)`로 설정.
   (Private 저장소는 GitHub 무료 플랜에서 Pages를 지원하지 않으므로, Private을 유지하려면
   GitHub Pro 이상 업그레이드가 필요하다. 이 저장소는 무료로 쓰기 위해 Public으로 운영 중이다.)
2. **Gemini API 키 등록**: https://aistudio.google.com 에서 무료로 API 키 발급(신용카드 불필요,
   분당/일일 요청 수 제한이 있는 무료 티어) → 저장소 Settings → Secrets and variables → Actions
   → New repository secret → 이름 `GOOGLE_GEMINI_API_KEY`, 값은 발급받은 키.
   (이 키는 GitHub Actions 안에서만 쓰이고 브라우저에는 절대 노출되지 않는다.)
3. **업로드용 Personal Access Token 발급**: 브라우저에서 파일을 커밋하려면 이 저장소 전용
   fine-grained PAT이 필요하다. GitHub → Settings → Developer settings → Fine-grained tokens
   → New token, Repository access를 이 저장소만으로 제한, Permissions:
   - Contents: Read and write
   - Pull requests: Read and write
   - Actions: Read-only
   발급받은 토큰을 사이트 하단 "선박 추가 / ROB Report 업데이트" 패널의 GitHub Token 입력란에
   붙여넣고 저장(브라우저 `localStorage`에만 저장되며 다른 곳으로 전송되지 않는다).

## 사용법

- **기존 선박 ROB 업데이트**: 선박 선택 → Bunker ROB Report 파일만 드래그 → 업로드.
  Capacity Plan도 같이 넣으면 해시를 비교해서, 이전과 동일한 파일이면 자동으로 재분석을 생략하고
  기존 스케치를 재사용한다 (Actions/Claude API 호출 자체가 발생하지 않아 비용이 절약됨).
- **신규 선박 추가**: 선박명 입력 + Capacity Plan + ROB Report 둘 다 드래그 → 업로드.
- 업로드 후 GitHub Actions가 분석을 마치면(보통 30~90초) 검토용 Pull Request가 자동 생성된다.
  ROB 수치와 Tank 구성을 확인하고 병합하면 사이트에 반영된다 (연료 수량 데이터라 자동 병합 대신
  1회 확인 절차를 둔 것 -- `.github/workflows/parse-bunker-upload.yml` 참고).

## 알려진 한계

- AI 분석은 Google Gemini(무료 API)를 사용한다. Anthropic Claude API보다 도면/표 판독 품질이
  떨어질 수 있어, 특히 스캔 도면처럼 텍스트 레이어가 없는 PDF에서는 PR의 결과를 더 꼼꼼히
  검토해야 한다. 유료 결제가 가능해지면 `scripts/parse.mjs`의 `callGemini`를 Claude API 호출로
  다시 바꾸면 된다 (Anthropic Messages API의 document 블록 + tool 강제 출력 방식, 과거 커밋 참고).
- 자동 좌표 계산(`scripts/parse.mjs`의 `computeLayout`)은 Port/Starboard에 한 줄로 배치되는
  일반적인 선박 구조를 가정한다. Bulgaria Prosperity처럼 같은 Frame 구간에 Tank가 위아래로
  2단씩 쌓인 특이 구조는 자동 생성 후 PR에서 `data/vessels/<id>.json`의 `position`/`size`를
  손으로 보정해야 할 수 있다.
- Bunker ROB Report의 Tank 이름 매칭은 유사도 기반이라, 도면과 Report의 Tank 표기가 크게
  다르면 매칭에 실패해 해당 항목이 `_unmatched`로 빠질 수 있다 (PR에서 확인 가능).

## 로컬 개발

```
npm install
npx http-server -p 8080 -c-1 .
```

`node scripts/migrate-legacy.mjs`는 예전 Claude Artifact(`../bunker-tank-plan/artifact/bunker-plan-console.html`)의
데이터를 `data/`로 1회성 변환하는 스크립트다 (이미 실행되어 12척이 반영되어 있음).
