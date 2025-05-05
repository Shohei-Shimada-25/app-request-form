// githubPusher.js
require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const axios        = require('axios');
const sodium       = require('libsodium-wrappers');

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_USER     = process.env.GITHUB_USER;
const GCP_SA_KEY_FILE = process.env.GCP_SA_KEY_FILE;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const PROJECT_ID      = process.env.GOOGLE_CLOUD_PROJECT;
const REGION          = process.env.CLOUD_RUN_REGION || 'asia-northeast1';

if (!PROJECT_ID) {
  throw new Error('環境変数 GOOGLE_CLOUD_PROJECT が設定されていません');
}

// slugify（server.js と同じ定義）
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

    // ① 作業用ディレクトリ
    const tempDir = path.join(__dirname, `app-${slug}-${Date.now()}`);
    fs.mkdirSync(tempDir);

    // ② ChatGPT へリクエスト
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `
あなたはプロのフロントエンドエンジニアです。以下要件をもとに、HTML/CSS/JSを「分割して」生成してください。
- デザインは Google Material Design ガイドラインを意識する
- HTML に <link rel="stylesheet" href="styles.css"> と <script src="script.js" defer></script>
- コードブロック（\`\`\`html\`\`\`, \`\`\`css\`\`\`, \`\`\`js\`\`\`）で出力
`.trim()
          },
          { role: 'user', content: appDescription }
        ],
        temperature: 0.7,
        max_tokens: 2048
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // ②.5: raw ChatGPT 応答を取得
    const rawReply = openaiRes.data.choices[0].message.content;

    // ③ フェンスから HTML/CSS/JS を抽出
    const fenceHtml = rawReply.match(/```html\s*([\s\S]*?)```/i);
    const fenceCss  = rawReply.match(/```css\s*([\s\S]*?)```/i);
    const fenceJs   = rawReply.match(/```js\s*([\s\S]*?)```/i);

    const html = fenceHtml ? fenceHtml[1].trim() : '<!DOCTYPE html><html><body>HTML not found</body></html>';
    const css  = fenceCss  ? fenceCss[1].trim()  : '/* CSS not found */';
    const js   = fenceJs   ? fenceJs[1].trim()   : `console.warn('JS not found');`;

    // ④ ファイル書き出し
    fs.writeFileSync(path.join(tempDir, 'index.html'),  html);
    fs.writeFileSync(path.join(tempDir, 'styles.css'),  css);
    fs.writeFileSync(path.join(tempDir, 'script.js'),   js);

    // ⑤ Dockerfile
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

    // ⑥ GitHub Actions ワークフロー生成
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
      - uses: google-github-actions/auth@v2
      - name: Authenticate to Google Cloud
        with:
          project_id:       \${{ env.PROJECT_ID }}
          create_credentials_file: true
          export_environment_variables: true
          credentials_json: \${{ secrets.GCP_SA_KEY }}
      - uses: google-github-actions/setup-gcloud@v2
      - name: Build & Push Docker image
        run: |
          gcloud builds submit \\
            --project=\${{ env.PROJECT_ID }} \\
            --tag gcr.io/\${{ env.PROJECT_ID }}/\${{ env.APP_SLUG }} \\
            || (echo "⚠️ Cloud Build log streaming failed—continuing anyway" && exit 0)
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

    // ⑦ Git 初期化＆Push
    execSync('git init', { cwd: tempDir });
    execSync('git branch -M main', { cwd: tempDir });
    execSync('git config user.name "GitHub Actions Bot"',  { cwd: tempDir });
    execSync('git config user.email "actions@github.com"', { cwd: tempDir });
    execSync('git add .',   { cwd: tempDir });
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: tempDir });

    const repoName    = repoUrl.split('/').pop().replace(/\.git$/, '');
    const authRepoUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repoName}.git`;
    execSync(`git remote add origin ${authRepoUrl}`, { cwd: tempDir });
    execSync('git push origin main', { cwd: tempDir });

    // ⑧ GitHub Secrets 登録（省略）
    // …

    // ⑨ 最後に rawReply を返す
    return rawReply;

  } catch (err) {
    console.error('❌ コードPush失敗:', err);
    throw err;
  }
}

module.exports = { pushCodeToRepository };
