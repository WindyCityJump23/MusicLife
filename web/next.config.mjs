/** @type {import('next').NextConfig} */
const nextConfig = {
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
