import { ReactNode } from "react";
import "./Styles.css";

interface ContentProps {
    children: ReactNode;
}

export default function Content(props: ContentProps) {
  return (
    <div className="content">
        {props.children}
    </div>
  )
}
