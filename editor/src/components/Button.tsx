import React, { useState } from 'react'

interface ButtonProps {
    onClick: () => void;
    selected?: boolean;
    children: React.ReactNode;
}
export default function Button(props: ButtonProps) {
  return (
    <div>
        <button onClick={()=>props.onClick()}> {props.children} </button>
    </div>
  )
}

export function ButtonWithConfirm(props: ButtonProps) {
    const [clicked, setClicked] = useState(false);
    return (
        <div>
            {!clicked && 
            <button onClick={() => setClicked(true)}>
                {props.children}
            </button>}
            {clicked && 
                <div>
                    <button onClick={() => setClicked(false)}>Cancel</button>
                    <button onClick={() => {setClicked(false); props.onClick()}}>Confirm</button>
                </div>
            }
        </div>
    )
}
