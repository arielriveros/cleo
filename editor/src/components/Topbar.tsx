import { ReactNode } from 'react';
import './Styles.css';

interface TopbarProps {
    children: ReactNode;
}

export default function Topbar(props: TopbarProps) {
  return (
    <div className="topbar">
        {props.children}
    </div>
  )
}