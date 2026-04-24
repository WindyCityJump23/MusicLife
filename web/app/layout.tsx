import "./globals.css";

export const metadata = {
  title: "Music Dashboard",
  description: "Taste-aware music discovery.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased bg-white text-neutral-900">{children}</body>
    </html>
  );
}
