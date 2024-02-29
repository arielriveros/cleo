import { ReactNode, useState, useEffect } from 'react';
import './Styles.css';

interface BottomBarProps {
  height?: string;
  minHeight?: string;
  children: ReactNode;
}

export default function BottomBar(props: BottomBarProps) {
  return (
    <div className="bottom-bar" style={{
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
      className="bottom-bar-resizer"
      onMouseDown={() => setDragging(true)}
    />
  );
}