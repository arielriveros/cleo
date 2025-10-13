import { ReactNode } from 'react';

interface TopbarProps {
    children: ReactNode;
}

export default function Topbar(props: TopbarProps) {
  return (
    <div className="fixed top-0 left-0 w-full h-[30px] flex flex-row items-center justify-between text-white bg-gradient-to-r from-[rgb(24,0,68)] via-[#3f3fb4] to-[rgb(24,0,68)] z-10">
        {props.children}
    </div>
  )
}