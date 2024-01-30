import { ReactNode } from 'react'
import './Styles.css';

interface CenterProps {
    children: ReactNode;
}
export default function Center(props: CenterProps) {
  return (
    <div className='center'>
        {props.children}
    </div>
  )
}
