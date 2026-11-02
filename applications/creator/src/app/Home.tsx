import type { ReactNode } from 'react';
import { LauncherCard, LauncherGlyph, LauncherGrid, LauncherPage } from '@cleo/app-kit/launcher/Launcher';
import { APPS, useCreatorShell, type AppId } from './shell';

// The Creator's start page: one card per app, laid out like the editor's project launcher.

const svg = (children: ReactNode) => (
  <svg className='w-12 h-12' viewBox='0 0 48 48' fill='none' stroke='currentColor' strokeWidth='2'
       strokeLinecap='round' strokeLinejoin='round'>{children}</svg>
);

const GLYPHS: Record<AppId, ReactNode> = {
  world: svg(<><path d='M4 38l12-18 8 10 6-8 14 16z' /><path d='M13 25l3 3 3-3' /><path d='M4 42h40' /></>),
  fx: svg(<><path d='M24 44c-8 0-13-6-13-13 0-8 7-12 8-21 6 4 9 9 9 14 2-2 3-5 3-7 5 4 7 9 7 14 0 7-6 13-14 13z' />
    <path d='M24 44c-3 0-6-3-6-7 0-4 4-6 6-10 2 4 6 6 6 10 0 4-3 7-6 7z' /></>),
  foliage: svg(<><path d='M10 38C10 20 22 8 40 8c0 18-12 30-30 30z' /><path d='M10 38L28 20' /><path d='M6 42l4-4' /></>),
  motion: svg(<><circle cx='26' cy='8' r='4' /><path d='M24 14l-4 12 6 6v10' /><path d='M20 26l-6 14' />
    <path d='M23 17l-9 4-3 7' /><path d='M24 15l8 6 6-2' /></>),
};

export function Home() {
  const { choose } = useCreatorShell();
  return (
    <LauncherPage title='CLEO ENGINE' subtitle='Creator' prompt='Choose an app to open.'>
      <div className='p-3'>
        <LauncherGrid minCard={150}>
          {APPS.map(app => (
            <LauncherCard key={app.id} name={app.label} description={app.description}
              thumbnail={<LauncherGlyph>{GLYPHS[app.id]}</LauncherGlyph>}
              onClick={() => choose(app.id)} />
          ))}
        </LauncherGrid>
      </div>
    </LauncherPage>
  );
}
