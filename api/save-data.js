// data.json, watchlist.json 등을 GitHub 저장소에 자동으로 커밋해주는 API
// 필요한 Vercel 환경변수: GITHUB_TOKEN (repo 권한 있는 Personal Access Token)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST 요청만 가능합니다' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'jchjjang0-web';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'stock-dashboard';

  // 허용된 파일만 저장 가능 (아무 경로나 덮어쓰지 못하도록 안전장치)
  const ALLOWED_FILES = ['data.json', 'watchlist.json'];

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ success: false, error: 'GITHUB_TOKEN 환경변수가 설정되지 않았습니다. Vercel 프로젝트 설정에서 추가해주세요.' });
  }

  try {
    const { data, file } = req.body || {};
    const FILE_PATH = ALLOWED_FILES.includes(file) ? file : 'data.json';

    if (!data) {
      return res.status(400).json({ success: false, error: '저장할 데이터가 없습니다' });
    }

    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;

    // 1) 기존 파일의 sha값 가져오기 (파일을 "수정"하려면 이게 필요함, 파일이 처음 생기는 거면 없어도 됨)
    const getRes = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json'
      }
    });

    let sha;
    if (getRes.ok) {
      const getJson = await getRes.json();
      sha = getJson.sha;
    }

    // 2) 새 데이터를 base64로 인코딩해서 커밋 (한글 깨짐 방지 위해 utf-8 명시)
    const jsonText = JSON.stringify(data, null, 2);
    const content = Buffer.from(jsonText, 'utf-8').toString('base64');

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `자동 저장 (${FILE_PATH}) · ${new Date().toISOString()}`,
        content,
        ...(sha ? { sha } : {})
      })
    });

    const putJson = await putRes.json();

    if (!putRes.ok) {
      return res.status(500).json({ success: false, error: putJson.message || 'GitHub 저장에 실패했습니다' });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
