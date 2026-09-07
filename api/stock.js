// 한국투자증권 API 프록시 (Vercel Serverless Function)
// 토큰 절약 버전: 기존 토큰 먼저 시도 → 실패 시에만 새로 발급
// + 코스피/코스닥 지수 조회 기능 추가 (type=index)
let cachedToken = null;
let tokenExpiry = 0;

async function getNewToken(BASE, APPKEY, APPSECRET) {
  const tokenRes = await fetch(BASE + '/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: APPKEY,
      appsecret: APPSECRET,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return null;
  cachedToken = tokenData.access_token;
  tokenExpiry = Date.now() + 20 * 60 * 60 * 1000;
  return cachedToken;
}

async function fetchPrice(BASE, APPKEY, APPSECRET, token, code) {
  const url = `${BASE}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
  const priceRes = await fetch(url, {
    headers: {
      'authorization': 'Bearer ' + token,
      'appkey': APPKEY,
      'appsecret': APPSECRET,
      'tr_id': 'FHKST01010100',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  return await priceRes.json();
}

// 코스피/코스닥 등 업종 지수 조회 (code: 0001=코스피, 1001=코스닥)
async function fetchIndex(BASE, APPKEY, APPSECRET, token, code) {
  const url = `${BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?fid_cond_mrkt_div_code=U&fid_input_iscd=${code}`;
  const res = await fetch(url, {
    headers: {
      'authorization': 'Bearer ' + token,
      'appkey': APPKEY,
      'appsecret': APPSECRET,
      'tr_id': 'FHPUP02100000',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  return await res.json();
}

// 관심종목(멀티종목) 시세조회 — 한 번의 호출로 최대 30종목까지 시세를 받아옴
// (기존에는 종목 1개당 요청 1번이 필요했지만, 이 방식은 30개를 묶어서 1번에 처리 → 훨씬 빠름)
async function fetchMultiPrice(BASE, APPKEY, APPSECRET, token, codes) {
  const params = new URLSearchParams();
  codes.slice(0, 30).forEach((code, i) => {
    const n = i + 1;
    params.set(`FID_COND_MRKT_DIV_CODE_${n}`, 'J');
    params.set(`FID_INPUT_ISCD_${n}`, code);
  });
  const url = `${BASE}/uapi/domestic-stock/v1/quotations/intstock-multprice?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'authorization': 'Bearer ' + token,
      'appkey': APPKEY,
      'appsecret': APPSECRET,
      'tr_id': 'FHKST11300006',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  return await res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const APPKEY = process.env.KIS_APPKEY;
  const APPSECRET = process.env.KIS_APPSECRET;
  const SERVER = process.env.KIS_SERVER || 'real';
  const BASE = SERVER === 'mock'
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';

  if (!APPKEY || !APPSECRET) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.' });
  }

  const { code, type, action, token: clientToken } = req.query;

  // 토큰만 미리 발급받는 요청 (여러 종목을 한꺼번에 조회하기 전에 1번만 호출)
  if (action === 'token') {
    try {
      // 기존 토큰이 아직 유효하면 그걸 재사용 (새로 발급 안 함)
      if (cachedToken && Date.now() < tokenExpiry) {
        return res.status(200).json({ success: true, token: cachedToken });
      }
      const newToken = await getNewToken(BASE, APPKEY, APPSECRET);
      if (!newToken) {
        return res.status(401).json({ error: '토큰 발급 실패' });
      }
      return res.status(200).json({ success: true, token: newToken });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 여러 종목을 한꺼번에 조회 (최대 30개씩) — 속도 개선용
  if (action === 'multi') {
    const codesParam = req.query.codes;
    if (!codesParam) {
      return res.status(400).json({ error: '종목코드 목록(codes)을 입력하세요. 예: /api/stock?action=multi&codes=005930,000660' });
    }
    const codes = String(codesParam).split(',').map(c => c.trim()).filter(Boolean).slice(0, 30);

    try {
      let data = null;

      // 0차: 클라이언트가 이미 발급받은 토큰을 보내줬으면 그걸 그대로 사용
      if (clientToken) {
        data = await fetchMultiPrice(BASE, APPKEY, APPSECRET, clientToken, codes);
      }

      // 1차: 기존 토큰이 있으면 시도
      if ((!data || !data.output) && cachedToken && Date.now() < tokenExpiry) {
        data = await fetchMultiPrice(BASE, APPKEY, APPSECRET, cachedToken, codes);
      }

      // 2차: 토큰 없거나 실패 → 새로 발급
      if (!data || !data.output) {
        const newToken = await getNewToken(BASE, APPKEY, APPSECRET);
        if (!newToken) {
          return res.status(401).json({ error: '토큰 발급 실패' });
        }
        data = await fetchMultiPrice(BASE, APPKEY, APPSECRET, newToken, codes);
      }

      if (data && Array.isArray(data.output)) {
        return res.status(200).json({ success: true, results: data.output.map(formatMultiOutput) });
      }

      return res.status(404).json({ error: '데이터를 찾을 수 없습니다', codes });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!code) {
    return res.status(400).json({ error: '종목 코드(code)를 입력하세요. 예: /api/stock?code=005930' });
  }

  const isIndex = type === 'index';

  try {
    // 0차: 클라이언트가 이미 발급받은 토큰을 보내줬으면 그걸 그대로 사용 (새 토큰 요청 안 함)
    if (clientToken) {
      const data = isIndex
        ? await fetchIndex(BASE, APPKEY, APPSECRET, clientToken, code)
        : await fetchPrice(BASE, APPKEY, APPSECRET, clientToken, code);
      if (data.output) {
        return res.status(200).json(isIndex ? formatIndexOutput(data.output, code) : formatOutput(data.output, code));
      }
      // 클라이언트 토큰이 만료 등으로 실패하면 아래로 계속
    }

    // 1차: 기존 토큰이 있으면 먼저 시도
    if (cachedToken && Date.now() < tokenExpiry) {
      const data = isIndex
        ? await fetchIndex(BASE, APPKEY, APPSECRET, cachedToken, code)
        : await fetchPrice(BASE, APPKEY, APPSECRET, cachedToken, code);
      if (data.output) {
        return res.status(200).json(isIndex ? formatIndexOutput(data.output, code) : formatOutput(data.output, code));
      }
      // 토큰 만료 등으로 실패하면 아래로 계속
    }

    // 2차: 토큰 없거나 실패 → 새로 발급
    const newToken = await getNewToken(BASE, APPKEY, APPSECRET);
    if (!newToken) {
      return res.status(401).json({ error: '토큰 발급 실패' });
    }

    const data = isIndex
      ? await fetchIndex(BASE, APPKEY, APPSECRET, newToken, code)
      : await fetchPrice(BASE, APPKEY, APPSECRET, newToken, code);
    if (data.output) {
      return res.status(200).json(isIndex ? formatIndexOutput(data.output, code) : formatOutput(data.output, code));
    }

    return res.status(404).json({ error: '데이터를 찾을 수 없습니다', code });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function formatOutput(o, code) {
  const sign = o.prdy_vrss_sign;
  return {
    success: true,
    code: code,
    name: o.hts_kor_isnm || '',
    price: parseInt(o.stck_prpr) || 0,
    change: parseInt(o.prdy_vrss) || 0,
    rate: parseFloat(o.prdy_ctrt) || 0,
    up: sign === '1' || sign === '2' ? true : sign === '4' || sign === '5' ? false : null,
    volume: parseInt(o.acml_vol) || 0,
    tradingValue: parseInt(o.acml_tr_pbmn) || 0,
    high: parseInt(o.stck_hgpr) || 0,
    low: parseInt(o.stck_lwpr) || 0,
    marketCap: parseInt(o.hts_avls) || 0,
  };
}

// 관심종목(멀티종목) 응답 1개 항목 포맷 (단일 종목 조회 결과와 필드명을 맞춰줌)
function formatMultiOutput(o) {
  const sign = o.prdy_vrss_sign;
  return {
    success: true,
    code: o.inter_shrn_iscd || '',
    name: o.inter_kor_isnm || '',
    price: parseInt(o.inter2_prpr) || 0,
    change: parseInt(o.inter2_prdy_vrss) || 0,
    rate: parseFloat(o.prdy_ctrt) || 0,
    up: sign === '1' || sign === '2' ? true : sign === '4' || sign === '5' ? false : null,
    volume: parseInt(o.acml_vol) || 0,
    tradingValue: parseInt(o.acml_tr_pbmn) || 0,
    high: parseInt(o.inter2_hgpr) || 0,
    low: parseInt(o.inter2_lwpr) || 0,
    marketCap: 0, // 이 API는 시가총액을 제공하지 않음 (대시보드에서 사용하지 않는 값이라 문제 없음)
  };
}

// 지수(코스피/코스닥) 응답 포맷
function formatIndexOutput(o, code) {
  const sign = o.prdy_vrss_sign;
  return {
    success: true,
    code: code,
    name: code === '0001' ? '코스피' : code === '1001' ? '코스닥' : (o.bstp_nmix_kor_isnm || ''),
    price: parseFloat(o.bstp_nmix_prpr) || 0,
    change: parseFloat(o.bstp_nmix_prdy_vrss) || 0,
    rate: parseFloat(o.bstp_nmix_prdy_ctrt) || 0,
    up: sign === '1' || sign === '2' ? true : sign === '4' || sign === '5' ? false : null,
    volume: parseInt(o.acml_vol) || 0,
    tradingValue: parseInt(o.acml_tr_pbmn) || 0,
  };
}
