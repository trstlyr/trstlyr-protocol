import type { Metadata } from 'next';
import type { Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'trstlyr.ai — Trust scores for the agent internet',
  description:
    'Before you install a skill, execute code, or delegate to another agent — ask first. Aegis aggregates GitHub, ERC-8004, ClawHub, and on-chain signals into a single verifiable trust score.',
  openGraph: {
    title: 'trstlyr.ai',
    description: 'Trust scores for the agent internet',
    url: 'https://trstlyr.ai',
    siteName: 'trstlyr.ai',
    type: 'website',
    images: [
      {
        url: 'https://trstlyr.ai/cover.jpg',
        width: 1200,
        height: 630,
        alt: 'TrstLyr — Trust scores for the agent internet',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'trstlyr.ai — Trust scores for the agent internet',
    description: 'Before you install, execute, or delegate — ask Aegis first.',
    images: ['https://trstlyr.ai/cover.jpg'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#0a0a0f] antialiased">{children}</body>
    </html>
  );
}
