// githubPusher.js
require('dotenv').config();

const fs          = require('fs');
const path        = require('path');
const { execSync }= require('child_process');
const axios       = require('axios');
const sodium      = require('libsodium-wrappers');

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_USER     = process.env.GITHUB_USER;
const GCP_SA_KEY_FILE = process.env.GCP_SA_KEY_FILE;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const PROJECT_ID      = process.env.GOOGLE_CLOUD_PROJECT;
const REGION          = process.env.CLOUD_RUN_REGION || 'asia-northeast1';

if (!PROJECT_ID) {
  throw new Error('環境変数 GOOGLE_CLOUD_PROJECT が設定されていません');
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function pushCodeToRepository(repoUrl, appName, appDescription) {
  try {
    const slug = slugify(appName);
    console.log('✅ app slug =', slug);

    // ① 作業用ディレクトリ
    const tempDir = path.join(__dirname, `app-${slug}-${Date.now()}`);
    fs.mkdirSync(tempDir);
    console.log(`✅ ① 作業用ディレクトリ: ${tempDir}`);

    // ② ChatGPT へ要件渡してコード生成依頼
    console.log('⏳ ② ChatGPT へコード生成依頼中…');
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: `
あなたはプロのフロントエンドエンジニアです。以下要件をもとに、HTML/CSS/JSを「分割して」生成してください。
- デザインは Google Material Design ガイドライン
- HTML に <link rel="stylesheet" href="styles.css"> と <script src="script.js" defer></script>
- コードブロック（\`\`\`html\`\`\`, \`\`\`css\`\`\`, \`\`\`js\`\`\`）で出力
`.trim() },
          { role: 'user', content: appDescription }
        ],
        temperature: 0.7,
        max_tokens: 2048
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const reply = openaiRes.data.choices[0].message.content;

    // ③ 生成コードをパースしてファイル化
    const html = (reply.match(/```html\s*([\s\S]*?)```/i)?.[1] ||
                  reply.match(/<html[\s\S]*?<\/html>/i)?.[0] ||
                  '<!DOCTYPE html><html><body>HTML not found</body></html>').trim();
    const css  = (reply.match(/```css\s*([\s\S]*?)```/i)?.[1] ||
                  (reply.match(/<style[\s\S]*?<\/style>/i)?.[0] || '').replace(/<\/?style>/gi, '').trim() ||
                  '/* CSS not found */');
    const js   = (reply.match(/```js\s*([\s\S]*?<\/script>```/i)?.[1] ||
                  (reply.match(/<script[\s\S]*?<\/script>/i)?.[0] || '').replace(/<\/?script>/gi, '').trim() ||
                  `console.warn('JS not found');`);

    fs.writeFileSync(path.join(tempDir, 'index.html'), html);
    fs.writeFileSync(path.join(tempDir, 'styles.css'), css);
    fs.writeFileSync(path.join(tempDir, 'script.js'), js);

    // ─── ここで必ず上書き ─────────────────────────────────────
    // Yes/No ボタンのクリック処理を追加で埋め込む
    const handlerJs = `
document.addEventListener('DOMContentLoaded', () => {
  const yesBtn = document.getElementById('yes-button');
  const noBtn  = document.getElementById('no-button');
  const result = document.getElementById('result');
  yesBtn?.addEventListener('click', () => { result.textContent = '正解'; });
  noBtn?.addEventListener('click', () => { result.textContent = '不正解'; });
});
`.trim();
    fs.writeFileSync(path.join(tempDir, 'script.js'), handlerJs);
    console.log('✅ ③ script.js を Yes/No ハンドラで上書きしました');

    // ④ Dockerfile
    const dockerfile = `
FROM nginx:alpine
ENV PORT 8080
RUN sed -i 's/listen       80;/listen       8080;/' /etc/nginx/conf.d/default.conf
EXPOSE 8080
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css  /usr/share/nginx/html/styles.css
COPY script.js   /usr/share/nginx/html/script.js
`.trim();
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile);

    // ⑤ GitHub Actions ワークフロー
    const workflowsDir = path.join(tempDir, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowYml = `
name: Deploy to Cloud Run

on:
  push:
    branches: [ main ]

env:
  APP_SLUG: ${slug}
  PROJECT_ID: ${PROJECT_ID}
  REGION: ${REGION}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: \${{ secrets.GCP_SA_KEY }}
          project_id:       \${{ env.PROJECT_ID }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Build & Push Docker image
        run: |
          gcloud builds submit \
            --project=\${{ env.PROJECT_ID }} \
            --tag gcr.io/\${{ env.PROJECT_ID }}/\${{ env.APP_SLUG }}

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy \${{ env.APP_SLUG }} \
            --project=\${{ env.PROJECT_ID }} \
            --image gcr.io/\${{ env.PROJECT_ID }}/\${{ env.APP_SLUG }} \
            --platform managed \
            --region \${{ env.REGION }} \
            --allow-unauthenticated
`.trim();
    fs.writeFileSync(path.join(workflowsDir, 'deploy.yml'), workflowYml);

    // ⑥ Git 初期化・Push
    execSync('git init',   { cwd: tempDir });
    execSync('git branch -M main', { cwd: tempDir });
    execSync('git config user.name "GitHub Actions Bot"', { cwd: tempDir });
    execSync('git config user.email "actions@github.com"', { cwd: tempDir });
    execSync('git add .',   { cwd: tempDir });
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: tempDir });

    const repoName    = repoUrl.split('/').pop().replace(/\.git$/, '');
    const authRepoUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repoName}.git`;
    execSync(`git remote add origin ${authRepoUrl}`, { cwd: tempDir });
    execSync('git push origin main', { cwd: tempDir });
    console.log('✅ ⑥ Push to GitHub 完了');

    // ⑦ GitHub Secrets 登録（GCP_SA_KEY）
    console.log('⏳ ⑦ Secrets 登録中…');
    await new Promise(r => setTimeout(r, 3000));
    const secretsUrl = `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/GCP_SA_KEY`;
    const gcpKeyB64  = fs.readFileSync(path.join(__dirname, GCP_SA_KEY_FILE), 'utf-8');
    const svcJson    = Buffer.from(gcpKeyB64, 'base64').toString('utf-8');
    const { data: pub } = await axios.get(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/public-key`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    await sodium.ready;
    const encrypted = sodium.crypto_box_seal(
      Buffer.from(svcJson),
      Buffer.from(pub.key, 'base64')
    );
    await axios.put(
      secretsUrl,
      { encrypted_value: Buffer.from(encrypted).toString('base64'), key_id: pub.key_id },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    console.log('✅ ⑦ Secrets 登録完了');

  } catch (err) {
    console.error('❌ コードPush失敗:', err.message);
    throw err;
  }
}

module.exports = { pushCodeToRepository };
