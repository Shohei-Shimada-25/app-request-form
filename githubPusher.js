// githubPusher.js
require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const axios        = require('axios');
const sodium       = require('libsodium-wrappers');
const { createNewRepository } = require('./githubRepoCreator');

const {
  GITHUB_TOKEN,
  GITHUB_USER,
  OPENAI_API_KEY,
  GOOGLE_CLOUD_PROJECT: PROJECT_ID,
  CLOUD_RUN_REGION: REGION = 'asia-northeast1',
} = process.env;

if (!PROJECT_ID || !GITHUB_TOKEN || !GITHUB_USER || !OPENAI_API_KEY) {
  throw new Error('必要な環境変数（GOOGLE_CLOUD_PROJECT, GITHUB_TOKEN, GITHUB_USER, OPENAI_API_KEY）が設定されていません');
}

async function pushCodeToRepository(repoUrl, appName, appDescription) {
  let rawReply;
  const slug = appName.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-');
  const repoName = repoUrl.split('/').pop().replace(/\.git$/,'');
  const tempDir = path.join(__dirname, `app-${slug}-${Date.now()}`);
  fs.mkdirSync(tempDir);

  // ② ChatGPT 生成（省略：既存ロジックそのまま）…
  //    ↓ rawReply, html, css, js の算出

  // ③ ファイル書き出し
  fs.writeFileSync(path.join(tempDir,'index.html'), html);
  fs.writeFileSync(path.join(tempDir,'styles.css'), css);
  fs.writeFileSync(path.join(tempDir,'script.js'), js);

  // ④ Dockerfile
  const dockerfile = `
FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
RUN apk add --no-cache git openssh-client
COPY . .
ENV PORT 8080
EXPOSE 8080
CMD ["node","server.js"]
`.trim();
  fs.writeFileSync(path.join(tempDir,'Dockerfile'), dockerfile);

  // ── ここから Git 操作 ─────────────────────────
  // 初回コミット（ワークフローはまだ入れない）
  execSync('git init', { cwd: tempDir });
  execSync('git branch -M main', { cwd: tempDir });
  execSync('git config user.name "Github Actions Bot"', { cwd: tempDir });
  execSync('git config user.email "actions@github.com"', { cwd: tempDir });
  execSync('git add .', { cwd: tempDir });
  execSync('git commit -m "Initial commit: app code"', { cwd: tempDir });

  const authUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repoName}.git`;
  execSync(`git remote add origin ${authUrl}`, { cwd: tempDir });
  execSync('git push origin main', { cwd: tempDir });

  // ── ⑤ Secrets 登録 ─────────────────────────────
  const secretsUrl = `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/GCP_SA_KEY`;
  const svcJson    = fs.readFileSync(path.join(__dirname, process.env.GCP_SA_KEY_FILE), 'utf8');
  const { data: publicKey } = await axios.get(
    `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/secrets/public-key`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
  );
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    Buffer.from(svcJson),
    Buffer.from(publicKey.key, 'base64')
  );
  await axios.put(
    secretsUrl,
    { encrypted_value: Buffer.from(encrypted).toString('base64'), key_id: publicKey.key_id },
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
  );

  // ── ⑥ Workflow 定義を追加 ───────────────────────
  const workflowsDir = path.join(tempDir,'.github','workflows');
  fs.mkdirSync(workflowsDir,{ recursive:true });
  const workflowYml = `
name: Deploy to Cloud Run
on:
  workflow_dispatch:
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
        create_credentials_file: true
        export_environment_variables: true
    - uses: google-github-actions/setup-gcloud@v2
      with:
        project_id: \${{ env.PROJECT_ID }}
    - name: Build & Push Docker image
      run: |
        gcloud builds submit \\
          --project=\${{ env.PROJECT_ID }} \\
          --tag gcr.io/\${{ env.PROJECT_ID }}/\${{ env.APP_SLUG }} 
    - name: Deploy to Cloud Run
      run: |
        gcloud run deploy \${{ env.APP_SLUG }} \\
          --project=\${{ env.PROJECT_ID }} \\
          --image gcr.io/\${{ env.PROJECT_ID }}/\${{ env.APP_SLUG }} \\
          --platform managed \\
          --region \${{ env.REGION }} \\
          --allow-unauthenticated
`.trim();
  fs.writeFileSync(path.join(workflowsDir,'deploy.yml'),workflowYml);

  // ⑦ ワークフローコミット＆Push
  execSync('git add .github/workflows/deploy.yml',{ cwd: tempDir });
  execSync('git commit -m "Add deploy workflow"',   { cwd: tempDir });
  execSync('git push origin main',                  { cwd: tempDir });

  // ⑧ 明示的にワークフローを dispatch
  await axios.post(
    `https://api.github.com/repos/${GITHUB_USER}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    { ref: 'main' },
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
  );

  // ── 完了情報を返却 ────────────────────────────
  const runUrl = `https://${slug}-${PROJECT_ID}.${REGION}.run.app`;
  return { repoUrl, runUrl, history: { user: appDescription, ai: rawReply } };
}

module.exports = { pushCodeToRepository };
