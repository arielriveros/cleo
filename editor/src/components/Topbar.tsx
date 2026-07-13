import { ReactNode } from 'react';

interface TopbarProps {
    children: ReactNode;
}

// Static flex child of the editor column (was `fixed top-0`); `relative z-30` keeps the MenuBar's
// dropdowns above the dock's stacking contexts (dockview overlays use z-index inside their own context).
export default function Topbar(props: TopbarProps) {
  return (
    <div className="relative z-30 shrink-0 w-full h-[30px] flex flex-row items-center justify-between text-white bg-gradient-to-r from-menubar via-primary to-menubar">
        {props.children}
    </div>
  )
}
