import type { ReactNode } from 'react';
import type { ExposureCurveKey } from 'cleo';
import { Hint, Slider, Toggle, cn } from '../../components/ui';
import ExposureCurveEditor from './ExposureCurveEditor';

/** The auto-exposure fields, by their RenderSettings names (the names an exposure volume overrides). */
export interface ExposureFieldValues {
  autoExposureEnabled: boolean;
  ev100: number;
  exposureCompensation: number;
  exposureCompensationCurve: ExposureCurveKey[];
  exposureMinEV: number;
  exposureMaxEV: number;
  exposureSpeedUp: number;
  exposureSpeedDown: number;
}
export type ExposureFieldKey = keyof ExposureFieldValues;

export interface ExposureOverrideControl {
  isOverridden: (key: ExposureFieldKey) => boolean;
  setOverridden: (key: ExposureFieldKey, on: boolean) => void;
}

export interface ExposureSettingsFieldsProps {
  values: ExposureFieldValues;
  onChange: (patch: Partial<ExposureFieldValues>) => void;
  /** The EV the meter is at, shown under the toggle while metering. */
  meteredEV?: number;
  labelClassName?: string;
  /**
   * Volume mode: each row gets a leading checkbox that overrides the field. A row left unchecked shows the
   * value it inherits, dimmed, and editing it checks it.
   */
  override?: ExposureOverrideControl;
}

/**
 * The exposure controls, shared by the Rendering panel (the scene's settings) and the Exposure Volume
 * inspector (a region's overrides of them), so the two read and behave the same.
 */
export function ExposureSettingsFields({ values, onChange, meteredEV, labelClassName, override }: ExposureSettingsFieldsProps) {
  const set = <K extends ExposureFieldKey>(key: K, value: ExposureFieldValues[K]) => {
    if (override && !override.isOverridden(key)) override.setOverridden(key, true);
    onChange({ [key]: value } as Partial<ExposureFieldValues>);
  };
  const row = (key: ExposureFieldKey, child: ReactNode) => {
    if (!override) return child;
    const on = override.isOverridden(key);
    return (
      <div className='flex items-center gap-1.5'>
        <input type='checkbox' className='shrink-0 accent-primary' checked={on}
          aria-label={`Override ${key}`} title={on ? 'Overridden here. Untick to use the scene\'s value.' : 'Using the scene\'s value. Tick to override it here.'}
          onChange={(e) => override.setOverridden(key, e.target.checked)} />
        <div className={cn('min-w-0 flex-1', !on && 'opacity-50')}>{child}</div>
      </div>
    );
  };
  const auto = values.autoExposureEnabled;

  return <>
    {row('autoExposureEnabled', <Toggle label='Auto exposure' checked={auto}
      onChange={(v) => set('autoExposureEnabled', v)} />)}
    {/* The manual slider is REPLACED rather than disabled while metering is on: a control that silently
        loses its value on the next frame is worse than one that is not there. The artist's handle is
        Compensation, which is how a camera works. */}
    {!auto && row('ev100', <Slider label={`Exposure (EV ${values.ev100.toFixed(2)})`}
      value={values.ev100} min={-4} max={17} step={0.25}
      onChange={(v) => set('ev100', v)} />)}
    {auto && <>
      {meteredEV !== undefined && <Hint>Metered at EV {meteredEV.toFixed(2)}.</Hint>}
      {row('exposureCompensation', <Slider label='Compensation (stops)' value={values.exposureCompensation} min={-4} max={4} step={0.1}
        onChange={(v) => set('exposureCompensation', v)} />)}
      {row('exposureCompensationCurve', <ExposureCurveEditor value={values.exposureCompensationCurve} labelClassName={labelClassName} meteredEV={meteredEV}
        onChange={(c) => set('exposureCompensationCurve', c)} />)}
      {row('exposureMinEV', <Slider label='Min EV' value={values.exposureMinEV} min={-4} max={17} step={0.5}
        onChange={(v) => set('exposureMinEV', v)} />)}
      {row('exposureMaxEV', <Slider label='Max EV' value={values.exposureMaxEV} min={-4} max={20} step={0.5}
        onChange={(v) => set('exposureMaxEV', v)} />)}
      {/* SPEEDS, so right is faster — the same two controls Unreal exposes, under the same names and with
          its defaults (3 and 1). */}
      {row('exposureSpeedUp', <Slider label='Adaptation speed (to bright)' value={values.exposureSpeedUp} min={0} max={10} step={0.1}
        onChange={(v) => set('exposureSpeedUp', v)} />)}
      {row('exposureSpeedDown', <Slider label='Adaptation speed (to dark)' value={values.exposureSpeedDown} min={0} max={10} step={0.1}
        onChange={(v) => set('exposureSpeedDown', v)} />)}
      <Hint>Higher adapts faster; 0 snaps with no easing. Eyes adjust to brightening
        faster than to darkening, which is why the two differ by default.</Hint>
    </>}
  </>;
}

export default ExposureSettingsFields;
