# 핫픽셀러 — Cloudflare + Firebase 배포 가이드

## 아키텍처 개요

```
[Firebase Hosting]          [Cloudflare Workers]         [Firebase Firestore]
index.html                  ──────────────────           ──────────────────
dashboard.html  ──fetch──▶  /trends                ──▶  cache/trends
payment.html                /products/search        ──▶  cache/products_*
                            /ai/generate            ──▶  ai_drafts/*
                            /pipeline/run           ──▶  pipeline_logs/*

[Firebase Auth]  ◀── 결제 성공 후 계정 생성 ── payment.html
[Toss Payments]  ◀── 구독 결제 요청 ────────── payment.html
[Claude API]     ◀── AI 생성 요청 ─────────── worker.js
```

---

## 1단계: Firebase 설정

### 1-1. Firebase 프로젝트 생성
1. https://console.firebase.google.com 접속
2. **새 프로젝트 추가** → 프로젝트 이름: `hotpickseller`
3. Google 애널리틱스: 선택 사항

### 1-2. Firebase 앱 등록 (Web)
1. 프로젝트 설정 > 앱 추가 > 웹 아이콘 클릭
2. 앱 닉네임: `hotpickseller-web`
3. 생성 후 나타나는 **firebaseConfig 복사**

### 1-3. 세 HTML 파일에 Firebase 설정 입력
`index.html`, `hotpickseller_dashboard_v2.html`, `hotpickseller_payment.html` 에서
아래 부분을 실제 값으로 교체:

```javascript
const firebaseConfig = {
  apiKey:            "여기에_FIREBASE_API_KEY",       // ← 교체
  authDomain:        "hotpickseller.firebaseapp.com",
  projectId:         "hotpickseller",                  // ← 본인 프로젝트 ID
  storageBucket:     "hotpickseller.appspot.com",
  messagingSenderId: "여기에_MESSAGING_SENDER_ID",    // ← 교체
  appId:             "여기에_APP_ID",                 // ← 교체
};
```

### 1-4. Firebase 서비스 활성화

**Authentication:**
- Firebase Console > Authentication > 시작하기
- 로그인 방법: **이메일/비밀번호** 활성화

**Firestore:**
- Firebase Console > Firestore Database > 데이터베이스 만들기
- 위치: `asia-northeast3` (서울)
- 보안 규칙 (테스트용):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;  // ⚠️ 프로덕션에서는 auth 기반으로 변경
    }
  }
}
```

### 1-5. `.firebaserc` 수정
```json
{
  "projects": {
    "default": "여기에_실제_프로젝트_ID"
  }
}
```

---

## 2단계: Cloudflare Workers 설정

### 2-1. Cloudflare 계정 및 Wrangler 설치
```bash
npm install -g wrangler
wrangler login
```

### 2-2. `worker/wrangler.toml` 수정
```toml
name = "hotpickseller-api"   # Workers 이름 (URL이 됨)
```

### 2-3. 환경변수 (Secrets) 설정
```bash
cd worker

# Claude API 키 (https://console.anthropic.com)
wrangler secret put ANTHROPIC_API_KEY

# Firebase 프로젝트 ID (예: hotpickseller-abc12)
wrangler secret put FIREBASE_PROJECT_ID

# Firebase Web API 키 (Firebase Console > 프로젝트 설정 > 웹 API 키)
wrangler secret put FIREBASE_API_KEY
```

### 2-4. Worker 배포
```bash
cd worker
wrangler deploy
```

배포 완료 후 URL 확인:
```
✅ https://hotpickseller-api.여러분계정.workers.dev
```

### 2-5. 대시보드에 Worker URL 입력
`hotpickseller_dashboard_v2.html` 에서:
```javascript
const API_BASE = "https://hotpickseller-api.여러분계정.workers.dev";
//                        ↑ 실제 URL로 교체
```

---

## 3단계: Firebase Hosting 배포

```bash
# Firebase CLI 설치
npm install -g firebase-tools
firebase login

# 배포
firebase deploy --only hosting
```

배포 완료 후:
```
✅ https://hotpickseller.web.app
✅ https://hotpickseller.firebaseapp.com
```

---

## 4단계: 로컬 개발 환경

### Worker 로컬 테스트
```bash
cd worker
wrangler dev
# → http://localhost:8787 에서 테스트
```

### Firebase Hosting 로컬 테스트
```bash
firebase serve --only hosting
# → http://localhost:5000 에서 테스트
```

대시보드에서 로컬 Worker를 사용하려면 `API_BASE`를 일시적으로:
```javascript
const API_BASE = "http://localhost:8787";
```

---

## 5단계: 토스페이먼츠 설정

1. https://developers.tosspayments.com 에서 계정 생성
2. 테스트 클라이언트 키 발급
3. `hotpickseller_payment.html` 에서:
```javascript
const TOSS_CLIENT_KEY = "test_ck_실제키입력";
```

---

## 파일 구조

```
hotpickseller/
├── index.html                       ← 랜딩페이지 (Firebase Hosting)
├── hotpickseller_dashboard_v2.html  ← 대시보드 (Firebase Hosting)
├── hotpickseller_payment.html       ← 결제 페이지 (Firebase Hosting)
├── firebase.json                    ← Hosting 설정
├── .firebaserc                      ← Firebase 프로젝트 연결
├── package.json                     ← 빌드/배포 스크립트
└── worker/
    ├── worker.js                    ← Cloudflare Worker (전체 API)
    └── wrangler.toml                ← Worker 설정
```

## API 엔드포인트 (Worker)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | / | 상태 확인 |
| GET | /trends | 구글 트렌드 키워드 (Firestore 1시간 캐시) |
| POST | /products/search | 도매 상품 탐색 + 마진 계산 |
| POST | /ai/generate | Claude AI 상세페이지 생성 |
| GET | /pipeline/run | 전체 파이프라인 백그라운드 실행 |

## Firebase 컬렉션 구조

| 컬렉션 | 설명 |
|--------|------|
| `cache/trends` | 트렌드 캐시 (1시간) |
| `cache/products_*` | 상품 검색 캐시 (30분) |
| `ai_drafts/*` | AI 생성 결과 저장 |
| `saved_products/*` | 사용자 저장 상품 |
| `subscriptions/{uid}` | 구독 정보 (plan, 만료일 등) |
| `pipeline_logs/*` | 파이프라인 실행 로그 |
