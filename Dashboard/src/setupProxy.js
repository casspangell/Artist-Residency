const { createProxyMiddleware } = require('http-proxy-middleware');

// Forward Python POSTs (and health checks) from CRA :3000 to the socket server.
module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://127.0.0.1:8080',
      changeOrigin: true,
    })
  );
};
