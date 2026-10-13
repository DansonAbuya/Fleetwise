/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['sharp', 'zod', 'tesseract.js', 'tesseract.js-core', 'pdfjs-dist', '@napi-rs/canvas'],
  outputFileTracingIncludes: {
    '/**': ['./scripts/**'],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    proxyTimeout: 300_000,
    serverActions: {
      bodySizeLimit: '12mb',
    },
  },
}

export default nextConfig
