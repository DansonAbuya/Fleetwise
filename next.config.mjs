/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['sharp', 'zod', 'tesseract.js', 'pdfjs-dist', '@napi-rs/canvas'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  serverActions: {
    bodySizeLimit: '12mb',
  },
  experimental: {
    proxyTimeout: 300_000,
  },
}

export default nextConfig
