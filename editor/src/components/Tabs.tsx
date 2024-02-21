import React from 'react'
import './Styles.css';

interface TabProps {
  title: string;
  onClick: () => void;
  selected?: boolean;
}

export function Tab(props: TabProps) {
  return (
    <button className='tabItem' disabled={props.selected} onClick={props.onClick}>{props.title}</button>
  )
}

interface TabsProps {
  children: React.ReactNode;
}
export default function Tabs(props: TabsProps) {
  return (
    <div className='tabContainer'>
      {props.children}
    </div>
  )
}
