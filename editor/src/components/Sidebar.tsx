import { ReactNode, DragEvent, useState, useEffect } from 'react';
import './Styles.css';

interface SidebarProps {
  width?: string;
  minWidth?: string;
  children: ReactNode;
}

export default function Sidebar(props: SidebarProps) {
  return (
    <div className="sidebar" style={{ width: props.width ?? '20vw', minWidth: props.minWidth ?? '20vw' }} >
      {props.children}
    </div>
  );
}

interface SidebarResizerProps {
  onDrag: (e: MouseEvent) => void;
}

export function SidebarResizer(props: SidebarResizerProps) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragging) {
        props.onDrag(e);
      }
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, props]);

  return (
    <div
      className="sidebar-resizer"
      onMouseDown={() => setDragging(true)}
    />
  );
}