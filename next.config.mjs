/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  // Permite abrir o pnpm dev pelo celular na rede local.
  allowedDevOrigins: ['192.168.1.8'],
};

export default nextConfig;

