import { ReactNode } from 'react';
import { cn } from './cn';
import { getWindowBridge } from '../platform/desktopWindow';
import WindowControls, { useTitleBarDrag } from './WindowControls';

interface TopbarProps {
    children: ReactNode;
}

// Static flex child of the editor column; `relative z-30` keeps the MenuBar's dropdowns above the
// dock's stacking contexts (dockview overlays use z-index inside their own context).
//
// In the desktop app's frameless windows (app-kit/desktop/windowControls.js) the bar is also the window's
// title bar: pressing it anywhere but a control and dragging moves the window, double-clicking maximizes,
// and the minimize, maximize / restore and close buttons follow everything else at its right end. In a
// browser, and on macOS, there is no window bridge and the bar is just the bar. (`cleo-titlebar` is a
// marker for tests and probes; it carries no CSS.)
export default function Topbar(props: TopbarProps) {
  const windowBridge = getWindowBridge();
  const drag = useTitleBarDrag(windowBridge);
  return (
    <div className={cn("relative z-30 shrink-0 w-full h-[30px] flex flex-row items-center justify-between text-fg bg-gradient-to-r from-menubar via-primary to-menubar",
                       windowBridge && 'cleo-titlebar select-none')}
         {...drag}>
        {windowBridge ? <>
          <div className='flex-1 min-w-0 h-full flex flex-row items-center justify-between'>{props.children}</div>
          <WindowControls bridge={windowBridge} />
        </> : props.children}
    </div>
  )
}
