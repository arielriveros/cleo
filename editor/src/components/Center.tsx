import { ReactNode } from 'react'
import './Styles.css';

interface CenterProps {
    width: string;
    children: ReactNode;
}
export default function Center(props: CenterProps) {
  return (
    <div className='center' style={{width: props.width}}>
        {props.children}
    </div>
  )
}
