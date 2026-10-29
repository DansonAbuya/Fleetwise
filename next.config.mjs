/** @type {import('next').NextConfig} */
const readerFiles = [
  './scripts/**',
  './node_modules/@napi-rs/canvas/**/*',
  './node_modules/@napi-rs/canvas-linux-x64-gnu/**/*',
  './node_modules/@napi-rs/canvas-linux-arm64-gnu/**/*',
  './node_modules/sharp/**/*',
  './node_modules/@img/sharp-linux-x64/**/*',
  './node_modules/@img/sharp-linux-arm64/**/*',
  './node_modules/@img/sharp-libvips-linux-x64/**/*',
  './node_modules/@img/sharp-libvips-linux-arm64/**/*',
  './node_modules/tesseract.js/**/*',
  './node_modules/tesseract.js-core/**/*',
  './node_modules/pdfjs-dist/**/*',
  './node_modules/zod/**/*',
]

const nextConfig = {
  serverExternalPackages: ['sharp', 'zod', 'tesseract.js', 'tesseract.js-core', 'pdfjs-dist', '@napi-rs/canvas', '@prisma/client', 'prisma'],
  // scripts/read-plate.mjs is loaded by path, so the function bundle must also carry the packages it imports.
  outputFileTracingIncludes: {
    '/**': readerFiles,
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
