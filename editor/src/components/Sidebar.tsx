import { ReactNode, useState, useEffect } from 'react';
import './Styles.css';

interface SidebarProps {
  width?: string;
  children: ReactNode;
}

export default function Sidebar(props: SidebarProps) {

  return (
    <div className="sidebar" style={{ width: props.width ?? '20vw' }} >
      {props.children}
    </div>
  );
}
