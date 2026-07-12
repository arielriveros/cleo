import { ReactNode, useState, useEffect } from 'react';

interface SidebarProps {
  width?: string;
  minWidth?: string;
  children: ReactNode;
}

export default function Sidebar(props: SidebarProps) {
  return (
    <div className="flex flex-col overflow-x-hidden overflow-y-auto select-none" style={{ width: props.width ?? '20vw', minWidth: props.minWidth ?? '20vw' }} >
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
      className="flex flex-col items-center justify-center w-[2px] h-full cursor-ew-resize bg-border hover:w-[5px] hover:bg-control-hover"
      onMouseDown={() => setDragging(true)}
    />
  );
}