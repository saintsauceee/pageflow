import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pageflow",
  description: "Helps you read PDFs with cool tools and features.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`$antialiased`}>
        {children}
      </body>
    </html>
  );
}
