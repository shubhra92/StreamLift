import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navigation } from "./components/Navigation";
import { ScrollActivity } from "./components/ScrollActivity";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StreamLift - Download Manager",
  description: "Download HTTP files and torrents to server or MEGA storage",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body
        className="flex h-dvh flex-col overflow-hidden"
        // className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ScrollActivity />
        <Navigation />
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </body>
    </html>
  );
}
