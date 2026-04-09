module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'bot.js',
      cwd: '/Users/uhershco/PycharmProjects/whatsapp-tools/bot',
      interpreter: 'node',
      restart_delay: 3000,       // wait 3s before restarting after crash
      max_restarts: 20,
      min_uptime: '10s',         // must stay up 10s to count as a successful start
      out_file: '/Users/uhershco/PycharmProjects/whatsapp-tools/logs/bot-out.log',
      error_file: '/Users/uhershco/PycharmProjects/whatsapp-tools/logs/bot-err.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'whatsapp-backend',
      script: '/Users/uhershco/PycharmProjects/whatsapp-tools/.venv/bin/uvicorn',
      args: 'main:app --host 0.0.0.0 --port 8000',
      cwd: '/Users/uhershco/PycharmProjects/whatsapp-tools/backend',
      interpreter: 'none',
      restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '10s',
      out_file: '/Users/uhershco/PycharmProjects/whatsapp-tools/logs/backend-out.log',
      error_file: '/Users/uhershco/PycharmProjects/whatsapp-tools/logs/backend-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
