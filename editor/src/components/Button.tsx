import React, { useState } from 'react'

interface ButtonProps {
    onClick: () => void;
    selected?: boolean;
    children: React.ReactNode;
}
export default function Button(props: ButtonProps) {
  return (
    <div>
        <button className='px-3 py-1 bg-[#3b3b3b] border border-[#2d2d77] rounded hover:bg-[#3f3fb4]' onClick={()=>props.onClick()}> {props.children} </button>
    </div>
  )
}

export function ButtonWithConfirm(props: ButtonProps) {
    const [clicked, setClicked] = useState(false);
    return (
        <div className='inline-flex items-center gap-2'>
            {!clicked && 
            <button className='px-3 py-1 bg-[#7b1b1b] border border-[#aa2222] rounded hover:bg-[#a02020]' onClick={() => setClicked(true)}>
                {props.children}
            </button>}
            {clicked && 
                <div className='inline-flex items-center gap-2'>
                    <button className='px-3 py-1 bg-[#3b3b3b] border border-[#2d2d77] rounded hover:bg-[#3f3fb4]' onClick={() => setClicked(false)}>Cancel</button>
                    <button className='px-3 py-1 bg-[#7b1b1b] border border-[#aa2222] rounded hover:bg-[#a02020]' onClick={() => {setClicked(false); props.onClick()}}>Confirm</button>
                </div>
            }
        </div>
    )
}
