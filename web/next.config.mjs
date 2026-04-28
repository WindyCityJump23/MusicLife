/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone output is only used by the Docker build.
  // Vercel handles Next.js natively and ignores this setting,
  // but setting it unconditionally breaks Vercel deploys.
  ...(process.env.DOCKER_BUILD === "true" ? { output: "standalone" } : {}),
  images: {
    remotePatterns: [
      {
        // Spotify album art CDN
        protocol: "https",
        hostname: "i.scdn.co",
      },
      {
        // Spotify mosaic/image CDN (older tracks)
        protocol: "https",
        hostname: "mosaic.scdn.co",
      },
      {
        // Spotify seeded-image CDN
        protocol: "https",
        hostname: "seed-mix-image.spotifycdn.com",
      },
    ],
  },
};

export default nextConfig;
