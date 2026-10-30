const fs = require('fs');
const path = require('path');

const venvPython =
  process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');

const interpreter = fs.existsSync(venvPython)
  ? venvPython
  : process.platform === 'win32'
    ? 'python'
    : 'python3';

module.exports = {
  apps: [
    {
      name: 'fbuploadpro-adu-downloader',
      script: 'worker.py',
      interpreter,
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
    },
  ],
};
