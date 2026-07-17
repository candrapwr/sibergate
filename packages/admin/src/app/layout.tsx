import type { Metadata } from 'next';
import { AppShell } from '@/components/layout/app-shell';
import { AppProviders } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'SiberGate Admin',
  description: 'SiberGate gateway admin panel',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <AppProviders>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}
