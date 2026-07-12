import React from 'react'

interface TabProps {
  title: string;
  onClick: () => void;
  selected?: boolean;
}

export function Tab(props: TabProps) {
  return (
    <button
      className='flex flex-row items-center h-[30px] px-[10px] cursor-pointer bg-control text-white border border-surface-raised border-b-0 rounded-t-[8px] hover:bg-control-hover disabled:bg-selected disabled:border-white disabled:border-b-0 disabled:cursor-default'
      disabled={props.selected}
      onClick={props.onClick}
    >
      {props.title}
    </button>
  )
}

interface TabsProps {
  children: React.ReactNode;
}
export default function Tabs(props: TabsProps) {
  return (
    <div className='flex flex-row w-full border border-control bg-surface-raised text-white'>
      {props.children}
    </div>
  )
}
