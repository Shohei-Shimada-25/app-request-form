// githubRepoCreator.js
const axios = require('axios');
require('dotenv').config();

const GITHUB_USER  = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function createNewRepository(repoName) {
  const url = 'https://api.github.com/user/repos';
  const data = {
    name: repoName,
    private: false
  };

  // Basic 認証ヘッダーを手動で組み立て
  const basicAuth = Buffer.from(`${GITHUB_USER}:${GITHUB_TOKEN}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${basicAuth}`,
    'Accept':        'application/vnd.github+json'
  };

  const res = await axios.post(url, data, { headers });
  return res.data.clone_url;  // 例: "https://github.com/あなた/リポ名.git"
}

module.exports = { createNewRepository };
