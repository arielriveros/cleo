import { ReactNode, useState, useEffect } from 'react';

interface BottomBarProps {
  height?: string;
  minHeight?: string;
  children: ReactNode;
}

export default function BottomBar(props: BottomBarProps) {
  return (
    <div className="flex flex-col w-full select-none" style={{
      display: props.height === '0vw' ? 'none': 'flex',
      height: props.height ?? '20vw',
      minHeight: props.minHeight ?? '20vw'

      }} >
      {props.children}
    </div>
  );
}

interface BottomBarResizerProps {
  onDrag: (e: MouseEvent) => void;
}

export function BottomBarResizer(props: BottomBarResizerProps) {
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
      className="flex flex-row items-center justify-center w-full h-[2px] cursor-ns-resize bg-[#2d2d77] hover:h-[5px] hover:bg-[#3f3fb4]"
      onMouseDown={() => setDragging(true)}
    />
  );
}