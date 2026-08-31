// Internal editor UI library — token-based, reusable primitives.
// Import from here, e.g. `import { Button, NumberInput, PropertyTable } from '../../components/ui'`.

export { cn } from './cn';

export { labelClass, valueClass, hintClass, sectionTitleClass } from './typography';

export { Button, buttonVariants, ButtonWithConfirm } from './Button';
export type { ButtonProps, ButtonWithConfirmProps } from './Button';

export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl';

export { NumberInput, TextInput, Select } from './inputs';
export type { NumberInputProps, TextInputProps, SelectProps } from './inputs';


export { Toggle } from './Toggle';
export type { ToggleProps } from './Toggle';

export { Slider } from './Slider';
export type { SliderProps } from './Slider';

export { VectorInput } from './VectorInput';
export type { VectorInputProps } from './VectorInput';

export { Popover } from './Popover';
export type { PopoverProps } from './Popover';

export { TypeSelect } from './TypeSelect';
export type { TypeSelectProps } from './TypeSelect';

export { AccessSelect, ACCESS_META } from './AccessSelect';
export type { AccessSelectProps } from './AccessSelect';



export { Field, Hint } from './Field';
export type { FieldProps } from './Field';

export { ColorInput } from './ColorInput';
export type { ColorInputProps } from './ColorInput';

export { PropertyTable, PropertyRow } from './PropertyTable';
export type { PropertyTableProps, PropertyRowProps } from './PropertyTable';

export { Panel, Section } from './Panel';
export type { SectionProps } from './Panel';

export { Modal, ModalHeader, ModalFooter } from './Modal';
export type { ModalProps } from './Modal';



// Primitives that live outside ui/, re-exported for a single import surface.
export { default as Collapsable } from '../Collapsable';
export { default as AxisInput } from '../AxisInput';
