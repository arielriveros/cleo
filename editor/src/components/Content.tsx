import { ReactNode } from "react";

interface ContentProps {
    children: ReactNode;
}

export default function Content(props: ContentProps) {
  return (
    <div className="fixed top-[30px] left-0 right-0 bottom-0 flex flex-row w-screen">
        {props.children}
    </div>
  )
}
