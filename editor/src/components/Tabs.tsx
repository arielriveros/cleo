import React from 'react'

interface TabProps {
  title: string;
  onClick: () => void;
  selected?: boolean;
}

export function Tab(props: TabProps) {
  return (
    <button
      className='flex flex-row items-center h-[30px] px-[10px] cursor-pointer bg-[#3b3b3b] text-white border border-[#202020] border-b-0 rounded-t-[8px] hover:bg-[#3f3fb4] disabled:bg-[#2c2cff] disabled:border-white disabled:border-b-0 disabled:cursor-default'
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
    <div className='flex flex-row w-full border border-[#3b3b3b] bg-[#202020] text-white'>
      {props.children}
    </div>
  )
}
