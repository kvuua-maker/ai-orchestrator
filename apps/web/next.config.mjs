export default {
  // SSE через проксі буферизується при gzip — вимикаємо стиснення
  compress: false,
  reactStrictMode: true,
  async rewrites() {
    const target = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4100";
    return [
      { source: "/v1/:path*", destination: `${target}/v1/:path*` },
      { source: "/healthz", destination: `${target}/healthz` },
    ];
  },
};
