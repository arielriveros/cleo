import React, { useEffect, useState } from "react";

interface AxisInputProps {
  step: number;
  min?: number;
  max?: number;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}

export default function AxisInput(props: AxisInputProps) {
  const [dragging, setDragging] = useState<boolean>(false);

  const handleInputChange = (index: number, newValue: number) => {
    const updatedValue = [...props.value];
    updatedValue[index] = newValue;
    const filledValue = updatedValue.concat(Array(3 - updatedValue.length).fill(0));
    props.onChange(filledValue as [number, number, number]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLInputElement>, index: number) => {
    if (dragging) {
      const delta = e.movementX * props.step;
      const updatedValue = [...props.value];
      updatedValue[index] += delta;
      const filledValue = updatedValue.concat(Array(3 - updatedValue.length).fill(0));
      props.onChange(filledValue as [number, number, number]);
    }
  };

  useEffect(() => {
    const handleMouseUp = () => {
      setDragging(false);
      document.exitPointerLock();
    };

    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div className="axis-input-container">
      <input
        className={'axis-input x'}
        type={'number'}
        step={props.step}
        min={props.min}
        max={props.max}
        value={props.value[0].toFixed(2)}
        onChange={(e) => handleInputChange(0, Number(e.target.value))}
        onMouseDown={(e) => {
          setDragging(true);
          e.currentTarget.requestPointerLock();
        }}
        onMouseMove={(e) => handleMouseMove(e, 0)}
      />
      <input
        className={'axis-input y'}
        type={'number'}
        step={props.step}
        min={props.min}
        max={props.max}
        value={props.value[1].toFixed(2)}
        onChange={(e) => handleInputChange(1, Number(e.target.value))}
        onMouseDown={(e) => {
          setDragging(true);
          e.currentTarget.requestPointerLock();
        }}
        onMouseMove={(e) => handleMouseMove(e, 1)}
      />
      <input
        className={'axis-input z'}
        type={'number'}
        step={props.step}
        min={props.min}
        max={props.max}
        value={props.value[2].toFixed(2)}
        onChange={(e) => handleInputChange(2, Number(e.target.value))}
        onMouseDown={(e) => {
          setDragging(true);
          e.currentTarget.requestPointerLock();
        }}
        onMouseMove={(e) => handleMouseMove(e, 2)}
      />
    </div>
  );
}