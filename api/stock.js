// 한국투자증권 API 프록시 (Vercel Serverless Function)
let cachedToken = null;
let tokenExpiry = 0;

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

  try {
    if (!cachedToken || Date.now() > tokenExpiry) {
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
      if (!tokenData.access_token) {
        return res.status(401).json({ error: '토큰 발급 실패', detail: tokenData });
      }
      cachedToken = tokenData.access_token;
      tokenExpiry = Date.now() + 20 * 60 * 60 * 1000;
    }

    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: '종목 코드(code)를 입력하세요. 예: /api/stock?code=005930' });
    }

    const url = `${BASE}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
    const priceRes = await fetch(url, {
      headers: {
        'authorization': 'Bearer ' + cachedToken,
        'appkey': APPKEY,
        'appsecret': APPSECRET,
        'tr_id': 'FHKST01010100',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
    const priceData = await priceRes.json();

    if (priceData.output) {
      const o = priceData.output;
      const sign = o.prdy_vrss_sign;
      return res.status(200).json({
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
      });
    }

    return res.status(404).json({ error: '종목 데이터를 찾을 수 없습니다', code });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
