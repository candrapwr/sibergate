import type { Metadata } from 'next';
import { Sidebar } from '@/components/layout/sidebar';
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
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-6xl px-8 py-6">{children}</div>
            </main>
          </div>
        </AppProviders>
      </body>
    </html>
  );
}
