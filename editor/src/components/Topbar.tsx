import { ReactNode } from 'react';

interface TopbarProps {
    children: ReactNode;
}

export default function Topbar(props: TopbarProps) {
  return (
    <div className="fixed top-0 left-0 w-full h-[30px] flex flex-row items-center justify-between text-white bg-gradient-to-r from-menubar via-primary to-menubar z-10">
        {props.children}
    </div>
  )
}