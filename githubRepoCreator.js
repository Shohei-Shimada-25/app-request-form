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
  // Basic auth で渡す
  const auth = {
    username: GITHUB_USER,
    password: GITHUB_TOKEN
  };
  const headers = {
    Accept: 'application/vnd.github+json'
  };

  const res = await axios.post(url, data, { auth, headers });
  // 作成されたリポジトリの HTTPS URL を返す
  return res.data.clone_url;
}

module.exports = { createNewRepository };
