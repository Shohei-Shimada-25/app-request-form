// githubRepoCreator.js
const axiosBase = require('axios');
require('dotenv').config();

const GITHUB_USER  = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function createNewRepository(repoName) {
  // 1) Basic 認証ヘッダーを組み立て
  const basicAuth = Buffer.from(`${GITHUB_USER}:${GITHUB_TOKEN}`)
    .toString('base64');

  // 2) OpenAI 用のグローバル axios とは別に、
  //    GitHub 専用の axios インスタンスを作成
  const axiosGit = axiosBase.create({
    baseURL: 'https://api.github.com',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Accept':        'application/vnd.github+json'
    }
  });

  // 3) リポジトリ作成APIを叩く
  const response = await axiosGit.post('/user/repos', {
    name:    repoName,
    private: false
  });

  // 4) 作成されたリポジトリのクローン URL を返却
  return response.data.clone_url;  // 例: https://github.com/あなた/リポ名.git
}

module.exports = { createNewRepository };
