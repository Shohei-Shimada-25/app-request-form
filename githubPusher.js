// githubPusher.js
require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const axios        = require('axios');
const sodium       = require('libsodium-wrappers');

const {
  GITHUB_TOKEN,
  GITHUB_USER,
  OPENAI_API_KEY,
  GOOGLE_CLOUD_PROJECT: PROJECT_ID,
  CLOUD_RUN_REGION: REGION = 'asia-northeast1',
  GCP_SA_KEY_FILE,
} = process.env;

if (!PROJECT_ID) {
  throw new Error('環境変数 GOOGLE_CLOUD_PROJECT が設定されていません');
}

// ─── slugify ─────────────────────────────────────────────────────
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// ─── GitHub Secret 登録 ──────────────────────────────────────────
async function registerSecret(repoName, secretName, secretValue) {
  const { data: publicKeyData } = await axios.get(
    `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/public-key`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept:        'application/vnd.github+json',
      },
    }
  );

  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    Buffer.from(secretValue),
    Buffer.from(publicKeyData.key, 'base64')
  );

  await axios.put(
    `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/${secretName}`,
    {
      encrypted_value: Buffer.from(encrypted).toString('base64'),
      key_id:          publicKeyData.key_id,
    },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept:        'application/vnd.github+json',
      },
    }
  );
}

// ─── Actions ワークフローの手動トリガー ──────────────────────────
async function dispatchWorkflow(repoName) {
  await axios.post(
    `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    { ref: 'main' },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept:        'application/vnd.github+json',
      },
    }
  );
}

// ─── メイン処理 ─────────────────────────────────────────────────
async function pushCodeToRepository(repoUrl, appName, appDescription) {
  let rawReply;
  try {
    // slug ベースを作成し、さらに timestamp を付与して常に一意にする
    const baseSlug   = slugify(appName);
    const uniqueSlug = `${baseSlug}-${Date.now()}`;
    console.log('✅ uniqueSlug =', uniqueSlug);

    // ① 作業ディレクトリを生成
    const tempDir = path.join(__dirname, `app-${uniqueSlug}`);
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`✅ 作業用ディレクトリ: ${tempDir}`);

    // ② ChatGPT にコード依頼
    const systemPrompt = `
あなたはプロのフロントエンドエンジニアです。以下要件をもとに、HTML/CSS/JSを「分割して」生成してください。
- デザインは Google Material Design ガイドラインを意識する
- HTML に <link rel="stylesheet" href="styles.css"> と <script src="script.js" defer></script>
- コードブロック（\`\`\`html\`\`\`, \`\`\`css\`\`\`, \`\`\`js\`\`\`）で出力
`.trim();
    console.log('⏳ ChatGPT へリクエスト中…');
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model:      'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: appDescription },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    rawReply = openaiRes.data.choices[0].message.content;
    console.log('▶ raw ChatGPT reply:\n', rawReply);

    // ③ フェンス抽出
    const fenceHtml = rawReply.match(/```html\s*([\s\S]*?)```/i);
    const fenceCss  = rawReply.match(/```css\s*([\s\S]*?)```/i);
    const fenceJs   = rawReply.match(/```js\s*([\s\S]*?)```/i);

    const html = fenceHtml ? fenceHtml[1].trim() : '<!DOCTYPE html><html><body>HTML not found</body></html>';
    const css  = fenceCss  ? fenceCss[1].trim()  : '/* CSS not found */';
    const js   = fenceJs   ? fenceJs[1].trim()   : `console.warn('JS not found');`;

    // ④ ファイル書き出し
    fs.writeFileSync(path.join(tempDir, 'index.html'), html);
    fs.writeFileSync(path.join(tempDir, 'styles.css'), css);
    fs.writeFileSync(path.join(tempDir, 'script.js'), js);

    // ⑤ Dockerfile 書き出し
    const dockerfile = `
FROM nginx:alpine
ENV PORT 8080
RUN sed -E -i 's/listen[[:space:]]+[0-9]+;/listen $PORT;/' /etc/nginx/conf.d/default.conf
EXPOSE 8080
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css  /usr/share/nginx/html/styles.css
COPY script.js   /usr/share/nginx/html/script.js
CMD ["nginx", "-g", "daemon off;"]
`.trim();
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile);

    // ⑥ GitHub リポジトリ作成（createNewRepository は slug 名を受け取る想定）
    const { createNewRepository } = require('./githubRepoCreator');
    const repoUrlNew = await createNewRepository(uniqueSlug);
    console.log('✅ GitHub リポジトリ作成:', repoUrlNew);
    const repoName = repoUrlNew.split('/').pop().replace(/\.git$/, '');

    // ⑦ 初回コミット (コード＋Dockerfileのみ)
    execSync('git init',       { cwd: tempDir });
    execSync('git branch -M main', { cwd: tempDir });
    execSync('git config user.name "GitHub Actions Bot"', { cwd: tempDir });
    execSync('git config user.email "actions@github.com"', { cwd: tempDir });
    execSync('git add index.html styles.css script.js Dockerfile', { cwd: tempDir });
    execSync('git commit -m "chore: initial code"',            { cwd: tempDir });

    // token 認証用 URL (ユーザー名省略可)
    const authRepoUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repoName}.git`;
    execSync(`git remote add origin ${authRepoUrl}`, { cwd: tempDir });
    execSync('git push origin main',                   { cwd: tempDir });
    console.log('✅ コードを GitHub に Push');

    // ⑧ GitHub Actions Secret 登録
    console.log('⏳ GitHub Secret を登録中…');
    const svcJson = fs.readFileSync(GCP_SA_KEY_FILE, 'utf-8');
    await registerSecret(repoName, 'GCP_SA_KEY', svcJson);
    console.log('✅ Secret 登録完了');

    // ⑨ ワークフロー定義を追加
    const workflowsDir = path.join(tempDir, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowYml = `
name: Deploy to Cloud Run
on:
  push:
    branches: [ main ]
env:
  APP_SLUG: ${uniqueSlug}
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
          create_credentials_file: true
          export_environment_variables: true
      - uses: google-github-actions/setup-gcloud@v2
        with:
          project_id: \${{ env.PROJECT_ID }}
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
            --allow-unauthenticated \
            --timeout 300s
`.trim();
    fs.writeFileSync(path.join(workflowsDir, 'deploy.yml'), workflowYml);

    // ⑩ ワークフローをコミット & Push
    execSync('git add .github/workflows/deploy.yml', { cwd: tempDir });
    execSync('git commit -m "chore: add deploy workflow"', { cwd: tempDir });
    execSync('git push origin main',                   { cwd: tempDir });
    console.log('✅ ワークフローを Push');

    // ⑪ 明示的にワークフローを Dispatch
    console.log('⏳ ワークフローを起動中…');
    await dispatchWorkflow(repoName);
    console.log('✅ Workflow dispatched');

    // ⑫ メタデータサーバからプロジェクト番号を取得
    const mdRes       = await axios.get(
      'http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id',
      {
        headers:      { 'Metadata-Flavor': 'Google' },
        responseType: 'text',
      }
    );
    const projNumber = mdRes.data.trim();
    const runUrl     = `https://${uniqueSlug}-${projNumber}.${REGION}.run.app`;

    return {
      repoUrl:  repoUrlNew,
      runUrl,
      history: {
        user: appDescription,
        ai:   rawReply,
      },
    };
  } catch (error) {
    console.error('❌ コードPush失敗:', error.response?.data || error);
    throw error;
  }
}

module.exports = { pushCodeToRepository };
