// server.js の冒頭に
console.log('🔥 GITHUB_TOKEN=', process.env.GITHUB_TOKEN?.slice(0,4));
console.log('🔥 GITHUB_USER =', process.env.GITHUB_USER);

// server.js
const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const { createNewRepository } = require('./githubRepoCreator');
const { pushCodeToRepository } = require('./githubPusher');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// JSON／フォーム送信両対応
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// public 配下を静的配信 (style.css 等)
app.use(express.static(path.join(__dirname, 'public')));

// フォーム画面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'form.html'));
});

// フォーム送信 → GitHub連携＋デプロイ
app.post('/submit', async (req, res) => {
  const { appName, appDescription } = req.body;
  console.log('✅ リクエスト受信', req.body);
  console.log('🔍 GITHUB_TOKEN:',    process.env.GITHUB_TOKEN?.slice(0,4) + '…');
  console.log('🔍 GITHUB_USER:',     process.env.GITHUB_USER);
  console.log('🔍 OPENAI_API_KEY:',  !!process.env.OPENAI_API_KEY);
  console.log('🔍 GCP_SA_KEY_FILE:', process.env.GCP_SA_KEY_FILE);
  console.log('🔍 PROJECT_NUMBER:',  process.env.PROJECT_NUMBER);
  console.log('🔍 CLOUD_RUN_REGION:',process.env.CLOUD_RUN_REGION);

  // ── デバッグログ：トークン & 認証確認 ──
  console.log('🔐 GITHUB_TOKEN:', process.env.GITHUB_TOKEN?.slice(0,4) + '…');
  let status;
  try {
    status = execSync(
      `curl -s -o /dev/null -w "%{http_code}" \
       -H "Authorization: token ${process.env.GITHUB_TOKEN}" \
       https://api.github.com/user`
    ).toString().trim();
  } catch (e) {
    status = 'curl_error';
  }
  console.log('🔐 GitHub /user HTTP status:', status);
  // ─────────────────────────────────────────

  try {
    // ① リポジトリ作成
    const repoUrl = await createNewRepository(appName);
    console.log('✅ リポジトリ作成完了', repoUrl);

    // ② コード生成・Push → Actions → Cloud Run デプロイ
    await pushCodeToRepository(repoUrl, appName, appDescription);
    console.log('✅ コードPush完了');

    // ③ 作成された Cloud Run URL を組み立て＆返却
    const projectNum = process.env.PROJECT_NUMBER;
    const region     = process.env.CLOUD_RUN_REGION;
    const appUrl     = `https://${appName}-${projectNum}.${region}.run.app`;

    return res.send(`
      <h1>アプリ作成成功！</h1>
      <p>GitHub リポジトリ: <a href="${repoUrl}" target="_blank">${repoUrl}</a></p>
      <p>Cloud Run URL: <a href="${appUrl}" target="_blank">${appUrl}</a></p>
      <p><a href="/">フォームに戻る</a></p>
    `);
  } catch (err) {
    console.error(err);
    return res.status(500).send(`
      <h1>エラーが発生しました</h1>
      <pre>${err.message}</pre>
      <p><a href="/">フォームに戻る</a></p>
    `);
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
