/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['unpdf', 'xlsx'],
  outputFileTracingIncludes: {
    '/api/**/*': [
      './cases/**/*',
      './docs/**/*',
      './tools/**/*',
    ],
  },
};

export default nextConfig;
