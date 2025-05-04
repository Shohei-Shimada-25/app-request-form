// githubPusher.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sodium = require('libsodium-wrappers');
require('dotenv').config();

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_USER     = process.env.GITHUB_USER;
const GCP_SA_KEY_FILE = process.env.GCP_SA_KEY_FILE;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const PROJECT_ID      = process.env.GOOGLE_CLOUD_PROJECT;

// ─── slugify 関数 ────────────────────────────────────────────────
function slugify(name) {
  return name
    .toLowerCase()                    // 小文字化
    .replace(/[^a-z0-9-]+/g, '-')     // 英数字以外をハイフンに
    .replace(/^-+|-+$/g, '')          // 先頭/末尾のハイフン除去
    .replace(/-{2,}/g, '-');          // 連続ハイフンを 1 つに
}

// ─── メイン処理 ──────────────────────────────────────────────
async function pushCodeToRepository(repoUrl, appName, appDescription) {
  try {
    // slug を作成
    const slug = slugify(appName);
    console.log('✅ app slug =', slug);

    // ① 作業用ディレクトリ作成
    const tempDir = path.join(__dirname, `app-${slug}-${Date.now()}`);
    fs.mkdirSync(tempDir);
    console.log(`✅ ③ 作業用ディレクトリ作成: ${tempDir}`);

    // ② ChatGPT にコード生成依頼
    console.log('⏳ ChatGPT へコード生成依頼中...');
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
- HTML には <link rel="stylesheet" href="styles.css"> と <script src="script.js" defer></script> を必ず含める
- コードブロック（\`\`\`html\`\`\`, \`\`\`css\`\`\`, \`\`\`js\`\`\`）で出力してください
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

    let reply = openaiRes.data.choices[0].message.content;

    // ③ コードブロック優先パース
    const fenceHtml = reply.match(/```html\s*([\s\S]*?)```/i);
    const fenceCss  = reply.match(/```css\s*([\s\S]*?)```/i);
    const fenceJs   = reply.match(/```js\s*([\s\S]*?)```/i);

    let html = fenceHtml
      ? fenceHtml[1].trim()
      : (reply.match(/<html[\s\S]*?<\/html>/i) || [''])[0];
    let css = fenceCss
      ? fenceCss[1].trim()
      : (reply.match(/<style[\s\S]*?<\/style>/i) || [''])[0]
          .replace(/<\/?style>/gi, '')
          .trim();
    let js = fenceJs
      ? fenceJs[1].trim()
      : (reply.match(/<script[\s\S]*?<\/script>/i) || [''])[0]
          .replace(/<\/?script>/gi, '')
          .trim();

    // フォールバック
    if (!html) html = '<!DOCTYPE html><html><body>HTML not found</body></html>';
    if (!css)  css  = '/* CSS not found */';
    if (!js)   js   = `console.warn('JS not found');`;

    // ④ ファイル書き出し
    fs.writeFileSync(path.join(tempDir, 'index.html'), html);
    fs.writeFileSync(path.join(tempDir, 'styles.css'), css);
    fs.writeFileSync(path.join(tempDir, 'script.js'), js);

    // ⑤ Dockerfile 作成 (nginx が 8080 を listen)
    const dockerfile = `
FROM nginx:alpine

# Cloud Run 用にポートを 8080 に変更
ENV PORT 8080
RUN sed -i 's/listen       80;/listen       8080;/' /etc/nginx/conf.d/default.conf
EXPOSE 8080

COPY index.html /usr/share/nginx/html/index.html
COPY styles.css  /usr/share/nginx/html/styles.css
COPY script.js   /usr/share/nginx/html/script.js
`.trim();
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile);

    // ⑥ GitHub Actions ワークフロー
    const workflowsDir = path.join(tempDir, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowYml = `
name: Deploy to Cloud Run

on:
  push:
    branches: [ main ]

env:
  APP_SLUG: ${slug}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: \${{ secrets.GCP_SA_KEY }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Build & Push Docker image
        run: |
          gcloud builds submit --tag gcr.io/${PROJECT_ID}/${slug} \
            || (echo "⚠️ Cloud Build log streaming failed" && exit 0)

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy \${{ env.APP_SLUG }} \
            --image gcr.io/\${{ env.PROJECT_ID }}/\${{ env.APP_SLUG }} \
            --platform managed \
            --region asia-northeast1 \
            --allow-unauthenticated
`.trim();
    fs.writeFileSync(path.join(workflowsDir, 'deploy.yml'), workflowYml);

    // ⑦ Git コミット & Push（token埋め込みURLで認証不要に）
    execSync('git init', { cwd: tempDir });
    execSync('git branch -M main', { cwd: tempDir });
    execSync('git config user.name "GitHub Actions Bot"', { cwd: tempDir });
    execSync('git config user.email "actions@github.com"', { cwd: tempDir });
    execSync('git add .', { cwd: tempDir });
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: tempDir });

    const repoName    = repoUrl.split('/').pop().replace(/\.git$/, '');
    const authRepoUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repoName}.git`;
    execSync(`git remote add origin ${authRepoUrl}`, { cwd: tempDir });
    execSync('git push origin main', { cwd: tempDir });
    console.log('✅ ④ コードPush成功！');

    // ⑧ GitHub Secrets 登録
    console.log('⏳ GitHub反映待機中...');
    await new Promise(r => setTimeout(r, 3000));
    console.log('✅ Secrets登録処理開始！');

    const secretsUrl = `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/GCP_SA_KEY`;
    const gcpKeyB64  = fs.readFileSync(GCP_SA_KEY_FILE, 'utf-8');
    const svcJson    = Buffer.from(gcpKeyB64, 'base64').toString('utf-8');

    const { data: publicKeyData } = await axios.get(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/public-key`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept:        'application/vnd.github+json'
        }
      }
    );

    await sodium.ready;
    const encrypted = sodium.crypto_box_seal(
      Buffer.from(svcJson),
      Buffer.from(publicKeyData.key, 'base64')
    );
    await axios.put(
      secretsUrl,
      { encrypted_value: Buffer.from(encrypted).toString('base64'), key_id: publicKeyData.key_id },
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept:        'application/vnd.github+json'
        }
      }
    );
    console.log('✅ Secrets登録成功！');

  } catch (error) {
    console.error('❌ コードPush失敗:', error.message);
    throw error;
  }
}

// デバッグ：環境変数が読み込まれているか確認
console.log('✅ GITHUB_TOKEN:', process.env.GITHUB_TOKEN?.slice(0,4) + '…');
console.log('✅ GITHUB_USER :', process.env.GITHUB_USER);

module.exports = { pushCodeToRepository };
