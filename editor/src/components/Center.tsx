import { ReactNode } from 'react'

interface CenterProps {
    width: string;
    children: ReactNode;
}
export default function Center(props: CenterProps) {
  return (
    <div className="flex flex-col w-full" style={{width: props.width}}>
        {props.children}
    </div>
  )
}
