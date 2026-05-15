/**
 * 핫픽셀러 — Cloudflare Worker API
 * FastAPI Python 백엔드를 대체합니다
 *
 * 환경변수 (wrangler.toml 또는 CF Dashboard에서 설정):
 *   ANTHROPIC_API_KEY   — Claude API 키
 *   FIREBASE_PROJECT_ID — Firebase 프로젝트 ID
 *   FIREBASE_API_KEY    — Firebase Web API 키 (Firestore REST용)
 */

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const COUPANG_FEE_RATE = 0.11;
const SHIPPING_COST = 3500;

// ── CORS ──────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// ── 메인 라우터 ───────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /
      if (path === "/" && request.method === "GET") {
        return json({ status: "ok", service: "핫픽셀러 API (Cloudflare Workers)" });
      }

      // GET /trends
      if (path === "/trends" && request.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "10");
        const category = url.searchParams.get("category") || null;
        const trends = await fetchTrends(env, limit, category);
        return json({ status: "ok", count: trends.length, trends });
      }

      // POST /products/search
      if (path === "/products/search" && request.method === "POST") {
        const body = await request.json();
        const { keyword, sources = ["도매꾹", "오너클랜", "젠트레이드"], max_results = 5 } = body;
        const products = await searchProducts(env, keyword, sources, max_results);
        return json({ status: "ok", keyword, count: products.length, products });
      }

      // POST /ai/generate
      if (path === "/ai/generate" && request.method === "POST") {
        const body = await request.json();
        const result = await generateProductPage(env, body);
        return json({ status: "ok", result });
      }

      // GET /pipeline/run
      if (path === "/pipeline/run" && request.method === "GET") {
        const category = url.searchParams.get("category") || null;
        ctx.waitUntil(runPipeline(env, category)); // 백그라운드 실행
        return json({ status: "started", message: "파이프라인이 백그라운드에서 실행중이에요" });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error("Worker error:", e);
      return json({ error: e.message }, 500);
    }
  },
};

// ════════════════════════════════════════════════════════════
// 1. 트렌드 수집 (구글 트렌드 RSS → Firestore 캐시)
// ════════════════════════════════════════════════════════════

const EXCLUDE_KEYWORDS = ["영화", "뉴스", "정치", "스포츠경기", "연예인", "드라마", "배우"];

const CATEGORY_MAP = {
  beauty: ["크림", "선크림", "화장품", "마스크팩", "자외선", "립", "세럼", "토너"],
  sports: ["캠핑", "등산", "헬스", "운동", "자전거", "낚시", "골프", "테니스"],
  home: ["청소", "수납", "주방", "침구", "조명", "인테리어", "에어컨", "선풍기"],
  fashion: ["원피스", "티셔츠", "바지", "신발", "가방", "의류", "패딩", "코트"],
  kitchen: ["텀블러", "도시락", "그릇", "냄비", "에어프라이어", "커피", "쿠커"],
};

async function fetchTrends(env, limit, category) {
  // Firestore 캐시 확인 (1시간)
  const cached = await firestoreGet(env, "cache", "trends");
  if (cached && Date.now() - cached.updatedAt < 3600_000) {
    let trends = cached.trends;
    if (category) trends = trends.filter((t) => t.category === category);
    return trends.slice(0, limit);
  }

  // 구글 트렌드 RSS (대한민국)
  let trends = [];
  try {
    const rssUrl = "https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR";
    const res = await fetch(rssUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HotpickSeller/1.0)" },
      cf: { cacheTtl: 3600 },
    });

    if (res.ok) {
      const xml = await res.text();
      trends = parseTrendsRSS(xml);
    }
  } catch (e) {
    console.warn("Google Trends fetch failed:", e.message);
  }

  // 트렌드 파싱 실패 → 샘플 데이터
  if (trends.length === 0) {
    trends = getSampleTrends();
  }

  // 제외 키워드 필터
  trends = trends.filter((t) => !EXCLUDE_KEYWORDS.some((ex) => t.keyword.includes(ex)));

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const result = trends.slice(0, 20).map((t, i) => ({
    rank: i + 1,
    keyword: t.keyword,
    score: t.score ?? Math.max(95 - i * 5, 20),
    category: guessCategory(t.keyword),
    change_rate: t.change_rate ?? Math.max(300 - i * 25, 20),
    is_rising: (t.change_rate ?? 200) > 50,
    collected_at: now,
  }));

  // Firestore에 캐시 저장
  await firestoreSet(env, "cache", "trends", { trends: result, updatedAt: Date.now() });

  let filtered = result;
  if (category) filtered = result.filter((t) => t.category === category);
  return filtered.slice(0, limit);
}

function parseTrendsRSS(xml) {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  return items.map((item, i) => {
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
      item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
    const traffic = (item.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/))?.[1]?.replace(/[^0-9]/g, "");
    return {
      keyword: title,
      score: Math.min(Math.max(95 - i * 3, 20), 100),
      change_rate: traffic ? Math.floor(parseInt(traffic) / 1000) : Math.max(300 - i * 20, 30),
    };
  }).filter((t) => t.keyword.length > 0);
}

function guessCategory(keyword) {
  for (const [cat, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some((kw) => keyword.includes(kw))) return cat;
  }
  return "기타";
}

function getSampleTrends() {
  return [
    { keyword: "자외선차단제", score: 95, change_rate: 340 },
    { keyword: "캠핑의자", score: 82, change_rate: 218 },
    { keyword: "에어컨청소", score: 74, change_rate: 190 },
    { keyword: "텀블러", score: 61, change_rate: 145 },
    { keyword: "무선청소기", score: 48, change_rate: 98 },
    { keyword: "냉감이불", score: 44, change_rate: 87 },
    { keyword: "여름원피스", score: 41, change_rate: 76 },
    { keyword: "아이스팩", score: 38, change_rate: 65 },
    { keyword: "모기퇴치", score: 35, change_rate: 54 },
    { keyword: "선풍기", score: 31, change_rate: 43 },
  ];
}

// ════════════════════════════════════════════════════════════
// 2. 도매 상품 탐색 + 마진 계산
// ════════════════════════════════════════════════════════════

const MOCK_PRODUCTS = {
  선크림: [
    { name: "SPF50+ PA++++ 선크림 100ml 무기자차", buy_price: 4800, source: "도매꾹" },
    { name: "워터프루프 선스틱 20g 대용량", buy_price: 3200, source: "오너클랜" },
    { name: "어린이 자외선차단제 무향 80ml", buy_price: 5500, source: "젠트레이드" },
  ],
  자외선차단제: [
    { name: "자외선차단 톤업 선크림 50ml", buy_price: 5200, source: "오너클랜" },
    { name: "UV차단 선쿠션 15g SPF50", buy_price: 6800, source: "도매꾹" },
  ],
  캠핑: [
    { name: "경량 폴딩 캠핑 의자 알루미늄", buy_price: 12000, source: "젠트레이드" },
    { name: "캠핑 LED 랜턴 USB충전식", buy_price: 8500, source: "도매꾹" },
    { name: "방수 캠핑 타프 3x3m", buy_price: 22000, source: "오너클랜" },
  ],
  캠핑의자: [
    { name: "경량 폴딩 캠핑 의자 알루미늄 접이식", buy_price: 11500, source: "젠트레이드" },
    { name: "컵홀더 캠핑 로우체어 커플", buy_price: 14000, source: "오너클랜" },
  ],
  텀블러: [
    { name: "스텐 보온 텀블러 500ml 직장인", buy_price: 7200, source: "도매꾹" },
    { name: "대용량 텀블러 1L 냉온 보온보냉", buy_price: 9500, source: "오너클랜" },
  ],
  무선청소기: [
    { name: "핸디형 무선 청소기 경량 2kg", buy_price: 38000, source: "젠트레이드" },
    { name: "차량용 무선 청소기 USB충전", buy_price: 15000, source: "도매꾹" },
  ],
  선풍기: [
    { name: "USB 미니 선풍기 휴대용 접이식", buy_price: 5500, source: "도매꾹" },
    { name: "탁상용 DC 선풍기 저소음 14인치", buy_price: 28000, source: "오너클랜" },
  ],
  냉감이불: [
    { name: "냉감 여름이불 싱글 Q max 0.4", buy_price: 18000, source: "오너클랜" },
    { name: "아이스 냉감 패드 더블 사이즈", buy_price: 22000, source: "젠트레이드" },
  ],
  모기퇴치: [
    { name: "USB 모기퇴치기 캠핑 가정용 LED", buy_price: 12000, source: "도매꾹" },
    { name: "모기장 원터치 팝업 싱글 침대용", buy_price: 9800, source: "오너클랜" },
  ],
};

async function searchProducts(env, keyword, sources, maxResults) {
  // 캐시 확인 (30분)
  const cacheKey = `products_${keyword}`;
  const cached = await firestoreGet(env, "cache", cacheKey);
  if (cached && Date.now() - cached.updatedAt < 1_800_000) {
    return cached.products.slice(0, maxResults);
  }

  // 키워드 매칭
  let rawProducts = [];
  for (const [key, products] of Object.entries(MOCK_PRODUCTS)) {
    if (key.includes(keyword) || keyword.includes(key)) {
      rawProducts.push(...products);
    }
  }

  // 매칭 없으면 랜덤 3개
  if (rawProducts.length === 0) {
    const all = Object.values(MOCK_PRODUCTS).flat();
    rawProducts = all.sort(() => Math.random() - 0.5).slice(0, 3);
  }

  // 요청한 소스 필터
  const filtered = rawProducts.filter((p) => sources.includes(p.source));
  const final = filtered.length > 0 ? filtered : rawProducts;

  const results = final
    .map((p) => buildProduct(keyword, p.name, p.buy_price, p.source))
    .filter((p) => p.margin_rate >= 15)
    .sort((a, b) => b.margin_rate - a.margin_rate);

  // Firestore 캐시 저장
  await firestoreSet(env, "cache", cacheKey, { products: results, updatedAt: Date.now() });

  return results.slice(0, maxResults);
}

function buildProduct(keyword, name, wholesale_price, source) {
  const recommended_price = Math.round(wholesale_price * 2.3);
  const coupang_fee = Math.round(recommended_price * COUPANG_FEE_RATE);
  const profit = recommended_price - wholesale_price - SHIPPING_COST - coupang_fee;
  const margin_rate = Math.max(Math.round((profit / recommended_price) * 100), 0);

  return {
    keyword,
    name,
    source,
    wholesale_price,
    recommended_price,
    coupang_fee,
    shipping_cost: SHIPPING_COST,
    estimated_profit: profit,
    margin_rate,
    min_order: 1,
    product_url: `https://www.${source === "도매꾹" ? "domeggook.com" : source === "오너클랜" ? "ownerclan.com" : "zentrade.co.kr"}/search?q=${encodeURIComponent(keyword)}`,
  };
}

// ════════════════════════════════════════════════════════════
// 3. AI 상품 정보 생성 (Claude API)
// ════════════════════════════════════════════════════════════

async function generateProductPage(env, { keyword, product_name, product_price, source }) {
  if (!env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY 없음 → 샘플 반환");
    return sampleAIResult(keyword, product_name);
  }

  const prompt = buildAIPrompt(keyword, product_name, product_price, source);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  let text = data.content[0].text.trim();

  // JSON 파싱 (마크다운 코드블록 제거)
  text = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const result = JSON.parse(text);

  // Firestore에 AI 결과 저장
  const docId = `${Date.now()}_${keyword.replace(/\s/g, "_")}`;
  await firestoreSet(env, "ai_drafts", docId, {
    keyword,
    product_name,
    product_price,
    source,
    result,
    createdAt: Date.now(),
  });

  return result;
}

function buildAIPrompt(keyword, product_name, price, source) {
  return `당신은 쿠팡 위탁판매 전문가입니다. 아래 상품 정보로 쿠팡 최적화 상품 정보를 JSON으로만 생성하세요.

입력 정보:
- 트렌드 키워드: ${keyword}
- 도매 상품명: ${product_name}
- 도매 매입가: ${price.toLocaleString()}원
- 출처: ${source}

다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):

{
  "optimized_title": "쿠팡 검색 최적화된 상품명 (50자 이내, 핵심 키워드 포함)",
  "search_tags": ["검색태그1", "검색태그2", "검색태그3", "검색태그4", "검색태그5"],
  "selling_points": [
    "판매 포인트 1",
    "판매 포인트 2",
    "판매 포인트 3"
  ],
  "description": "상품 상세 설명 (200자 이내, 구매 혜택 중심)",
  "caution": "사용 시 주의사항",
  "recommended_category": "쿠팡 카테고리명"
}

규칙:
1. optimized_title은 반드시 트렌드 키워드(${keyword})를 포함할 것
2. search_tags는 실제 구매자가 검색할 키워드로
3. 한국어로 작성
4. JSON만 출력, 설명 텍스트 없음`;
}

function sampleAIResult(keyword, product_name) {
  return {
    optimized_title: `[인기급상승] ${keyword} ${product_name.slice(0, 15)} 고품질 정품`,
    search_tags: [keyword, product_name.slice(0, 6), "인기상품", "무료배송", "국내당일발송"],
    selling_points: ["트렌드 급상승 인기 상품", "도매 직거래로 합리적인 가격", "빠른 배송 및 안전한 포장"],
    description: `${keyword} 관련 상품으로 높은 만족도를 자랑합니다. 합리적인 가격과 빠른 배송으로 고객 만족을 최우선으로 합니다.`,
    caution: "상품 수령 후 이상이 있을 경우 즉시 문의 주세요.",
    recommended_category: "생활/건강",
  };
}

// ════════════════════════════════════════════════════════════
// 4. 전체 파이프라인 (백그라운드)
// ════════════════════════════════════════════════════════════

async function runPipeline(env, category) {
  console.log("🔥 파이프라인 시작");

  // 1단계: 트렌드 수집
  const trends = await fetchTrends(env, 5, category);
  console.log(`📈 트렌드 ${trends.length}개 수집`);

  // 2단계: 상위 3개 키워드 상품 탐색
  for (const trend of trends.slice(0, 3)) {
    const products = await searchProducts(env, trend.keyword, ["도매꾹", "오너클랜", "젠트레이드"], 3);
    console.log(`🔍 [${trend.keyword}] ${products.length}개 상품 발견`);

    // 3단계: 마진 20% 이상 상품만 AI 생성
    for (const product of products) {
      if (product.margin_rate >= 20 && env.ANTHROPIC_API_KEY) {
        try {
          const result = await generateProductPage(env, {
            keyword: trend.keyword,
            product_name: product.name,
            product_price: product.wholesale_price,
            source: product.source,
          });
          console.log(`✦ AI 생성: ${result.optimized_title?.slice(0, 30)}...`);
        } catch (e) {
          console.error(`AI 생성 실패: ${e.message}`);
        }
      }
    }
  }

  // 파이프라인 실행 로그 저장
  await firestoreSet(env, "pipeline_logs", `run_${Date.now()}`, {
    category,
    trends_count: trends.length,
    ran_at: Date.now(),
  });

  console.log("✅ 파이프라인 완료");
}

// ════════════════════════════════════════════════════════════
// 5. Firebase Firestore REST API 헬퍼
// ════════════════════════════════════════════════════════════

function firestoreUrl(env, collection, docId = null) {
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;
  const key = `?key=${env.FIREBASE_API_KEY}`;
  return docId ? `${base}/${docId}${key}` : `${base}${key}`;
}

/** Firestore 문서 읽기 */
async function firestoreGet(env, collection, docId) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) return null;
  try {
    const res = await fetch(firestoreUrl(env, collection, docId));
    if (!res.ok) return null;
    const doc = await res.json();
    return fsDocToObject(doc);
  } catch {
    return null;
  }
}

/** Firestore 문서 쓰기 (PATCH = upsert) */
async function firestoreSet(env, collection, docId, data) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) return;
  try {
    const body = { fields: objectToFsFields(data) };
    await fetch(firestoreUrl(env, collection, docId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("Firestore write failed:", e.message);
  }
}

/** JS 객체 → Firestore fields 형식 */
function objectToFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") fields[k] = { stringValue: v };
    else if (typeof v === "number") fields[k] = { doubleValue: v };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
    else if (Array.isArray(v)) {
      fields[k] = {
        arrayValue: {
          values: v.map((item) =>
            typeof item === "string"
              ? { stringValue: item }
              : typeof item === "number"
              ? { doubleValue: item }
              : { stringValue: JSON.stringify(item) }
          ),
        },
      };
    } else if (v !== null && typeof v === "object") {
      fields[k] = { stringValue: JSON.stringify(v) }; // 중첩 객체는 JSON으로
    } else if (v === null) {
      fields[k] = { nullValue: null };
    }
  }
  return fields;
}

/** Firestore fields → JS 객체 */
function fsDocToObject(doc) {
  if (!doc.fields) return null;
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    if ("stringValue" in v) {
      // JSON 파싱 시도 (저장된 객체 복원)
      try {
        obj[k] = v.stringValue.startsWith("{") || v.stringValue.startsWith("[")
          ? JSON.parse(v.stringValue)
          : v.stringValue;
      } catch {
        obj[k] = v.stringValue;
      }
    } else if ("doubleValue" in v) obj[k] = v.doubleValue;
    else if ("integerValue" in v) obj[k] = parseInt(v.integerValue);
    else if ("booleanValue" in v) obj[k] = v.booleanValue;
    else if ("arrayValue" in v) {
      obj[k] = (v.arrayValue.values || []).map((item) =>
        "stringValue" in item ? item.stringValue : "doubleValue" in item ? item.doubleValue : null
      );
    } else if ("nullValue" in v) obj[k] = null;
  }
  return obj;
}
