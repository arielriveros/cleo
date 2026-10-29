// Internal editor UI library — token-based, reusable primitives.
// Import from here, e.g. `import { Button, NumberInput, PropertyTable } from './'`.

export { cn } from './cn';

export { labelClass, valueClass, hintClass, sectionTitleClass, hintAffordance } from './typography';

export { Button, buttonVariants, ButtonWithConfirm } from './Button';
export type { ButtonProps, ButtonWithConfirmProps } from './Button';

export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl';

export { NumberInput, OptionalNumberInput, TextInput, Select, controlClass } from './inputs';
export type { NumberInputProps, OptionalNumberInputProps, TextInputProps, SelectProps } from './inputs';

export { FileButton } from './FileButton';
export type { FileButtonProps } from './FileButton';

export { MenuItem } from './MenuItem';
export type { MenuItemProps } from './MenuItem';


export { TexturePicker } from './TexturePicker';
export type { TexturePickerProps } from './TexturePicker';

export { Toggle } from './Toggle';
export type { ToggleProps } from './Toggle';

export { Slider } from './Slider';
export type { SliderProps } from './Slider';

export { StringListInput } from './StringListInput';
export type { StringListInputProps } from './StringListInput';

export { VectorInput } from './VectorInput';
export type { VectorInputProps } from './VectorInput';

export { Popover } from './Popover';
export type { PopoverProps } from './Popover';

export { PresetMenu } from './PresetMenu';
export type { PresetMenuProps, PresetMenuEntry } from './PresetMenu';

export { ComboSelect } from './ComboSelect';
export type { ComboSelectProps, ComboChoice } from './ComboSelect';

export { TypeSelect } from './TypeSelect';
export type { TypeSelectProps } from './TypeSelect';

export { AccessSelect, ACCESS_META } from './AccessSelect';
export type { AccessSelectProps } from './AccessSelect';



export { Field, Hint } from './Field';
export type { FieldProps } from './Field';

export { ColorInput } from './ColorInput';
export type { ColorInputProps } from './ColorInput';

export { CurveInput, CurveGraph, graphRange, snapGraphValue } from './CurveInput';
export type { CurveInputProps, CurveGraphProps } from './CurveInput';

export { GradientInput } from './GradientInput';
export type { GradientInputProps } from './GradientInput';

export { RangeInput } from './RangeInput';
export type { RangeInputProps } from './RangeInput';

export { PropertyTable, PropertyRow } from './PropertyTable';
export type { PropertyTableProps, PropertyRowProps } from './PropertyTable';

export { Panel, Section, SectionTitle } from './Panel';
export type { SectionProps, SectionTitleProps } from './Panel';

export { Modal, ModalHeader, ModalFooter } from './Modal';
export type { ModalProps, ModalHeaderProps } from './Modal';

// Docs-driven hover cards (the text comes from docs/**/*.md via features/docs).
export { DocHover, useDocTooltip, docTitleAffordance } from './DocTooltip';
export type { DocHoverProps, DocTooltipHandle } from './DocTooltip';
export { DocScope, useDocEntry } from '../docs/DocScope';



// Primitives that live outside ui/, re-exported for a single import surface.
export { default as Collapsable } from './Collapsable';
export { default as AxisInput } from './AxisInput';
