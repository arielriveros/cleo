import { clamp, dampTime } from "../../../math";
import { Node } from "../node";
import { UISpacerNode } from "./uiContainers";
import { UINode, numTuple, rgba } from "./uiNode";
import type { UIColor, UIFillDirection } from "./uiNode";

/**
 * Interactive UI elements: Button, ProgressBar, Slider, Toggle, TextInput.
 */

export class UIButtonNode extends UINode {
    private _label: string = 'Button';
    private _disabled: boolean = false;
    private _hoverTint: UIColor = rgba(1, 1, 1, 0.15);
    private _pressedTint: UIColor = rgba(0, 0, 0, 0.2);
    private _disabledTint: UIColor = rgba(0.5, 0.5, 0.5, 0.4);

    constructor(name: string = 'button', id?: string) {
        super(name, 'uiButton', id);
        this._offsetMax = [120, 36];
        this._tint = rgba(0.2, 0.4, 0.8, 1);
        this._interactive = true;   // a button nobody can click is never what was meant
        this._borderRadius = 4;
    }

    public get label(): string { return this._label; }
    public set label(v: string) { const p = this._label; this._label = String(v ?? ''); this._touch(); this._notifyChange('component', 'label', p, this._label); }
    public get disabled(): boolean { return this._disabled; }
    public set disabled(v: boolean) { const p = this._disabled; this._disabled = v; this._touch(); this._notifyChange('component', 'disabled', p, v); }
    public get hoverTint(): UIColor { return this._hoverTint; }
    public set hoverTint(v: UIColor) { const p = this._hoverTint; this._hoverTint = numTuple(v, rgba(1, 1, 1, 0.15)); this._touch(); this._notifyChange('component', 'hoverTint', p, this._hoverTint); }
    public get pressedTint(): UIColor { return this._pressedTint; }
    public set pressedTint(v: UIColor) { const p = this._pressedTint; this._pressedTint = numTuple(v, rgba(0, 0, 0, 0.2)); this._touch(); this._notifyChange('component', 'pressedTint', p, this._pressedTint); }
    public get disabledTint(): UIColor { return this._disabledTint; }
    public set disabledTint(v: UIColor) { const p = this._disabledTint; this._disabledTint = numTuple(v, rgba(0.5, 0.5, 0.5, 0.4)); this._touch(); this._notifyChange('component', 'disabledTint', p, this._disabledTint); }

    /**
     * Called when this button is activated.
     *
     * A real script handler (it is in `SCRIPT_HANDLERS`), so a class script overriding it gets the same
     * throw-guard and async-rejection handling every other handler does.
     */
    public onPress(): void {}

    /**
     * Fire this button, honouring `disabled`.
     *
     * The DOM layer's click handler goes through here rather than calling {@link onPress} directly, so the
     * disabled rule lives in the engine and applies equally to a script that presses a button itself.
     */
    public press(): void {
        if (this._disabled) return;
        this.onPress();
    }

    protected _serializeUIPayload(): any {
        return {
            label: this._label, disabled: this._disabled,
            hoverTint: [...this._hoverTint], pressedTint: [...this._pressedTint],
            disabledTint: [...this._disabledTint],
        };
    }

    protected _parsePayload(ui: any): void {
        if (typeof ui.label === 'string') this._label = ui.label;
        if (typeof ui.disabled === 'boolean') this._disabled = ui.disabled;
        this._hoverTint = numTuple(ui.hoverTint, this._hoverTint);
        this._pressedTint = numTuple(ui.pressedTint, this._pressedTint);
        this._disabledTint = numTuple(ui.disabledTint, this._disabledTint);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIButtonNode(json.name, json.id), parent, json);
    }
}

/**
 * A row or column that positions its children in flow instead of by anchors.
 *
 * Children keep their cross-axis anchors, so a column of full-width rows is `stretch` on X plus a height
 * on Y — the stack only owns the main axis. A child with a {@link UISpacerNode}'s `flex` absorbs slack.
 */

export class UIProgressBarNode extends UINode {
    private _min: number = 0;
    private _max: number = 1;
    private _value: number = 1;
    private _fillTint: UIColor = rgba(0.2, 0.8, 0.3, 1);
    private _direction: UIFillDirection = 'ltr';
    private _smoothing: number = 0;

    /** Displayed fill, which chases `value` when `smoothing > 0`. */
    private _displayed: number = 1;

    constructor(name: string = 'progress bar', id?: string) {
        super(name, 'uiProgressBar', id);
        this._offsetMax = [200, 16];
        this._tint = rgba(0, 0, 0, 0.5);
        this._borderRadius = 3;
    }

    public get min(): number { return this._min; }
    public set min(v: number) { const p = this._min; this._min = v; this._touch(); this._notifyChange('component', 'min', p, v); }
    public get max(): number { return this._max; }
    public set max(v: number) { const p = this._max; this._max = v; this._touch(); this._notifyChange('component', 'max', p, v); }
    public get value(): number { return this._value; }
    public set value(v: number) {
        if (v === this._value) return;   // written every frame by gameplay scripts
        const p = this._value;
        this._value = v;
        if (this._smoothing <= 0) this._displayed = v;
        this._touch();
        this._notifyChange('component', 'value', p, v);
    }
    public get fillTint(): UIColor { return this._fillTint; }
    public set fillTint(v: UIColor) { const p = this._fillTint; this._fillTint = numTuple(v, rgba(0.2, 0.8, 0.3, 1)); this._touch(); this._notifyChange('component', 'fillTint', p, this._fillTint); }
    public get direction(): UIFillDirection { return this._direction; }
    public set direction(v: UIFillDirection) { const p = this._direction; this._direction = v; this._touch(); this._notifyChange('component', 'direction', p, v); }
    public get smoothing(): number { return this._smoothing; }
    public set smoothing(v: number) { const p = this._smoothing; this._smoothing = Math.max(0, v); this._touch(); this._notifyChange('component', 'smoothing', p, this._smoothing); }

    /** Fill fraction in 0..1, after smoothing. What the DOM layer sizes the fill element with. */
    public get fraction(): number {
        const span = this._max - this._min;
        if (span === 0) return 0;
        return clamp((this._displayed - this._min) / span, 0, 1);
    }

    /**
     * Advance the smoothed fill.
     *
     * Runs from the ordinary node update (not the UI layout pass) because it is simulation, not layout:
     * it must be frozen while the game is paused, which the layout pass deliberately is not.
     */
    public update(delta: number, time: number): void {
        super.update(delta, time);
        if (this._smoothing > 0 && this._displayed !== this._value) {
            const next = dampTime(this._displayed, this._value, this._smoothing, delta);
            // Snap once inside a hair of the target, or the fill creeps forever and the DOM layer
            // re-writes a style every frame for a difference nobody can see.
            this._displayed = Math.abs(next - this._value) < 1e-4 ? this._value : next;
            this._touch();
        }
    }

    protected _serializeUIPayload(): any {
        return {
            min: this._min, max: this._max, value: this._value,
            fillTint: [...this._fillTint], direction: this._direction, smoothing: this._smoothing,
        };
    }

    protected _parsePayload(ui: any): void {
        if (typeof ui.min === 'number') this._min = ui.min;
        if (typeof ui.max === 'number') this._max = ui.max;
        if (typeof ui.value === 'number') { this._value = ui.value; this._displayed = ui.value; }
        this._fillTint = numTuple(ui.fillTint, this._fillTint);
        if (['ltr', 'rtl', 'btt', 'ttb'].includes(ui.direction)) this._direction = ui.direction;
        if (typeof ui.smoothing === 'number') this._smoothing = Math.max(0, ui.smoothing);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIProgressBarNode(json.name, json.id), parent, json);
    }
}

/** A draggable value between `min` and `max`. Reports through `onValueChanged`. */
export class UISliderNode extends UINode {
    private _min: number = 0;
    private _max: number = 1;
    private _step: number = 0;
    private _value: number = 0.5;
    private _fillTint: UIColor = rgba(0.2, 0.5, 0.9, 1);
    private _handleTint: UIColor = rgba(1, 1, 1, 1);
    private _vertical: boolean = false;

    constructor(name: string = 'slider', id?: string) {
        super(name, 'uiSlider', id);
        this._offsetMax = [200, 24];
        this._tint = rgba(0, 0, 0, 0.5);
        this._interactive = true;
    }

    public get min(): number { return this._min; }
    public set min(v: number) { const p = this._min; this._min = v; this._touch(); this._notifyChange('component', 'min', p, v); }
    public get max(): number { return this._max; }
    public set max(v: number) { const p = this._max; this._max = v; this._touch(); this._notifyChange('component', 'max', p, v); }
    public get step(): number { return this._step; }
    public set step(v: number) { const p = this._step; this._step = Math.max(0, v); this._touch(); this._notifyChange('component', 'step', p, this._step); }
    public get value(): number { return this._value; }
    public set value(v: number) {
        const next = this._quantize(v);
        if (next === this._value) return;
        const p = this._value;
        this._value = next;
        this._touch();
        this._notifyChange('component', 'value', p, next);
    }
    public get fillTint(): UIColor { return this._fillTint; }
    public set fillTint(v: UIColor) { const p = this._fillTint; this._fillTint = numTuple(v, rgba(0.2, 0.5, 0.9, 1)); this._touch(); this._notifyChange('component', 'fillTint', p, this._fillTint); }
    public get handleTint(): UIColor { return this._handleTint; }
    public set handleTint(v: UIColor) { const p = this._handleTint; this._handleTint = numTuple(v, rgba(1, 1, 1, 1)); this._touch(); this._notifyChange('component', 'handleTint', p, this._handleTint); }
    public get vertical(): boolean { return this._vertical; }
    public set vertical(v: boolean) { const p = this._vertical; this._vertical = v; this._touch(); this._notifyChange('component', 'vertical', p, v); }

    /** Position in 0..1, for the DOM layer to place the fill and the handle. */
    public get fraction(): number {
        const span = this._max - this._min;
        return span === 0 ? 0 : clamp((this._value - this._min) / span, 0, 1);
    }

    private _quantize(v: number): number {
        const lo = Math.min(this._min, this._max);
        const hi = Math.max(this._min, this._max);
        const c = clamp(v, lo, hi);
        if (this._step <= 0) return c;
        return clamp(this._min + Math.round((c - this._min) / this._step) * this._step, lo, hi);
    }

    /** Called when the user moves the slider. Not fired when a script assigns `value`. */
    public onValueChanged(_value: number): void {}

    /**
     * Apply a drag from the DOM layer, in 0..1 along the slider's track.
     *
     * Separate from the `value` setter so the handler only fires for USER input — a script setting
     * `value` should not re-enter its own `onValueChanged` and loop.
     */
    public setValueFromFraction(fraction: number): void {
        const before = this._value;
        this.value = this._min + clamp(fraction, 0, 1) * (this._max - this._min);
        if (this._value !== before) this.onValueChanged(this._value);
    }

    protected _serializeUIPayload(): any {
        return {
            min: this._min, max: this._max, step: this._step, value: this._value,
            fillTint: [...this._fillTint], handleTint: [...this._handleTint], vertical: this._vertical,
        };
    }

    protected _parsePayload(ui: any): void {
        if (typeof ui.min === 'number') this._min = ui.min;
        if (typeof ui.max === 'number') this._max = ui.max;
        if (typeof ui.step === 'number') this._step = Math.max(0, ui.step);
        if (typeof ui.value === 'number') this._value = ui.value;
        this._fillTint = numTuple(ui.fillTint, this._fillTint);
        this._handleTint = numTuple(ui.handleTint, this._handleTint);
        if (typeof ui.vertical === 'boolean') this._vertical = ui.vertical;
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UISliderNode(json.name, json.id), parent, json);
    }
}

/** An on/off switch. Reports through `onValueChanged`. */
export class UIToggleNode extends UINode {
    private _checked: boolean = false;
    private _label: string = 'Toggle';
    private _onTint: UIColor = rgba(0.2, 0.7, 0.4, 1);
    private _offTint: UIColor = rgba(0.3, 0.3, 0.3, 1);

    constructor(name: string = 'toggle', id?: string) {
        super(name, 'uiToggle', id);
        this._offsetMax = [160, 24];
        this._interactive = true;
    }

    public get checked(): boolean { return this._checked; }
    public set checked(v: boolean) {
        if (v === this._checked) return;
        const p = this._checked;
        this._checked = v;
        this._touch();
        this._notifyChange('component', 'checked', p, v);
    }
    public get label(): string { return this._label; }
    public set label(v: string) { const p = this._label; this._label = String(v ?? ''); this._touch(); this._notifyChange('component', 'label', p, this._label); }
    public get onTint(): UIColor { return this._onTint; }
    public set onTint(v: UIColor) { const p = this._onTint; this._onTint = numTuple(v, rgba(0.2, 0.7, 0.4, 1)); this._touch(); this._notifyChange('component', 'onTint', p, this._onTint); }
    public get offTint(): UIColor { return this._offTint; }
    public set offTint(v: UIColor) { const p = this._offTint; this._offTint = numTuple(v, rgba(0.3, 0.3, 0.3, 1)); this._touch(); this._notifyChange('component', 'offTint', p, this._offTint); }

    /** Called when the user flips the switch. Not fired when a script assigns `checked`. */
    public onValueChanged(_checked: boolean): void {}

    /** Flip the switch as a USER action, firing `onValueChanged`. The DOM layer calls this. */
    public toggle(): void {
        this.checked = !this._checked;
        this.onValueChanged(this._checked);
    }

    protected _serializeUIPayload(): any {
        return { checked: this._checked, label: this._label, onTint: [...this._onTint], offTint: [...this._offTint] };
    }

    protected _parsePayload(ui: any): void {
        if (typeof ui.checked === 'boolean') this._checked = ui.checked;
        if (typeof ui.label === 'string') this._label = ui.label;
        this._onTint = numTuple(ui.onTint, this._onTint);
        this._offTint = numTuple(ui.offTint, this._offTint);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIToggleNode(json.name, json.id), parent, json);
    }
}

/** A single-line text field. Reports through `onValueChanged` while typing and `onSubmit` on Enter. */
export class UITextInputNode extends UINode {
    private _value: string = '';
    private _placeholder: string = '';
    private _maxLength: number = 0;
    private _password: boolean = false;
    private _readOnly: boolean = false;
    private _fontSize: number = 14;

    constructor(name: string = 'text input', id?: string) {
        super(name, 'uiTextInput', id);
        this._offsetMax = [200, 28];
        this._tint = rgba(1, 1, 1, 0.9);
        this._interactive = true;
        this._borderWidth = 1;
        this._borderColor = rgba(0, 0, 0, 0.4);
    }

    public get value(): string { return this._value; }
    public set value(v: string) {
        const next = String(v ?? '');
        if (next === this._value) return;
        const p = this._value;
        this._value = this._maxLength > 0 ? next.slice(0, this._maxLength) : next;
        this._touch();
        this._notifyChange('component', 'value', p, this._value);
    }
    public get placeholder(): string { return this._placeholder; }
    public set placeholder(v: string) { const p = this._placeholder; this._placeholder = String(v ?? ''); this._touch(); this._notifyChange('component', 'placeholder', p, this._placeholder); }
    public get maxLength(): number { return this._maxLength; }
    public set maxLength(v: number) { const p = this._maxLength; this._maxLength = Math.max(0, Math.floor(v)); this._touch(); this._notifyChange('component', 'maxLength', p, this._maxLength); }
    public get password(): boolean { return this._password; }
    public set password(v: boolean) { const p = this._password; this._password = v; this._touch(); this._notifyChange('component', 'password', p, v); }
    public get readOnly(): boolean { return this._readOnly; }
    public set readOnly(v: boolean) { const p = this._readOnly; this._readOnly = v; this._touch(); this._notifyChange('component', 'readOnly', p, v); }
    public get fontSize(): number { return this._fontSize; }
    public set fontSize(v: number) { const p = this._fontSize; this._fontSize = Math.max(1, v); this._touch(); this._notifyChange('component', 'fontSize', p, this._fontSize); }

    /** Called while the user types. Not fired when a script assigns `value`. */
    public onValueChanged(_value: string): void {}
    /** Called when the user commits the field (Enter). */
    public onSubmit(_value: string): void {}

    /** Apply typing from the DOM layer, firing `onValueChanged` only for genuine user edits. */
    public setValueFromInput(next: string): void {
        if (this._readOnly) return;
        const before = this._value;
        this.value = next;
        if (this._value !== before) this.onValueChanged(this._value);
    }

    /** Commit the field (Enter), firing `onSubmit`. */
    public submit(): void { this.onSubmit(this._value); }

    protected _serializeUIPayload(): any {
        return {
            value: this._value, placeholder: this._placeholder, maxLength: this._maxLength,
            password: this._password, readOnly: this._readOnly, fontSize: this._fontSize,
        };
    }

    protected _parsePayload(ui: any): void {
        if (typeof ui.value === 'string') this._value = ui.value;
        if (typeof ui.placeholder === 'string') this._placeholder = ui.placeholder;
        if (typeof ui.maxLength === 'number') this._maxLength = Math.max(0, Math.floor(ui.maxLength));
        if (typeof ui.password === 'boolean') this._password = ui.password;
        if (typeof ui.readOnly === 'boolean') this._readOnly = ui.readOnly;
        if (typeof ui.fontSize === 'number') this._fontSize = Math.max(1, ui.fontSize);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UITextInputNode(json.name, json.id), parent, json);
    }
}
