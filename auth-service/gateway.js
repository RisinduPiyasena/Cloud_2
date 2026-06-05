const AUTH_SERVICE = process.env.AUTH_SERVICE_URL || "http://localhost:4005";

app.use("/api/auth", createProxyMiddleware({
  target: AUTH_SERVICE,
  changeOrigin: true,
  pathRewrite: { "^/api/auth": "/auth" },
}));