// githubRepoCreator.js
const axios = require('axios');
require('dotenv').config();

const GITHUB_USER  = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function createNewRepository(repoName) {
  // 内部で Basic は使わずに token スキームを使う
  const axiosGit = axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept:        'application/vnd.github+json'
    }
  });

  const response = await axiosGit.post('/user/repos', {
    name:    repoName,
    private: false
  });

  return response.data.clone_url;
}

module.exports = { createNewRepository };
