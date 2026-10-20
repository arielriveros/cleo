// The loading screen a runtime scene switch shows (`Game.loadScene(name, { loadingScreen })`).
//
// HOST-level DOM, over the engine's viewport, rather than scene UI: whatever the outgoing scene drew is
// disposed with it halfway through the load, and the incoming scene has not parsed yet. Only something
// that lives outside both can stay on screen across the swap. Same place in the editor's Play view and
// in a published game, because both hand the engine the element it renders into.

export interface LoadingOverlayOptions {
    /** Heading over the bar. */
    title?: string;
}

export interface LoadingOverlay {
    /** Move the bar to `fraction` (0..1, never backwards) and, optionally, name the stage. */
    set(fraction: number, stage?: string): void;
    /** Fade out and detach. */
    hide(): void;
}

/** Shown over `host` (the engine viewport) until `hide`. A no-op shell where there is no DOM. */
export function showLoadingOverlay(host: HTMLElement | null | undefined, options: LoadingOverlayOptions = {}): LoadingOverlay {
    if (!host || typeof document === 'undefined') return { set() { }, hide() { } };

    // The overlay is positioned against the viewport, which a static element would not be.
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const root = document.createElement('div');
    root.className = 'cleo-scene-loading';
    Object.assign(root.style, {
        position: 'absolute', inset: '0', zIndex: '1000', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '18px', background: '#050506',
        color: '#d8d2c4', fontFamily: 'Georgia, "Times New Roman", serif', opacity: '1',
        transition: 'opacity 400ms ease', pointerEvents: 'auto', userSelect: 'none',
    } as Partial<CSSStyleDeclaration>);

    const title = document.createElement('div');
    title.textContent = options.title ?? 'Loading';
    Object.assign(title.style, { fontSize: '28px', letterSpacing: '0.12em' } as Partial<CSSStyleDeclaration>);

    const track = document.createElement('div');
    Object.assign(track.style, {
        width: 'min(420px, 60%)', height: '6px', background: 'rgba(255,255,255,0.12)', borderRadius: '3px',
        overflow: 'hidden',
    } as Partial<CSSStyleDeclaration>);
    const fill = document.createElement('div');
    Object.assign(fill.style, {
        width: '0%', height: '100%', background: '#c9b27a', transition: 'width 250ms ease-out',
    } as Partial<CSSStyleDeclaration>);
    track.appendChild(fill);

    const stage = document.createElement('div');
    Object.assign(stage.style, { fontSize: '13px', opacity: '0.6', minHeight: '1em' } as Partial<CSSStyleDeclaration>);

    root.append(title, track, stage);
    host.appendChild(root);

    let shown = 0;
    return {
        set(fraction: number, label?: string) {
            shown = Math.max(shown, Math.min(1, Math.max(0, fraction)));
            fill.style.width = `${(shown * 100).toFixed(1)}%`;
            if (label !== undefined) stage.textContent = label;
        },
        hide() {
            root.style.opacity = '0';
            root.style.pointerEvents = 'none';
            setTimeout(() => root.remove(), 450);
        },
    };
}

/** Resolve on the next animation frame, so a stage's progress paints before the next one blocks. */
export function nextFrame(): Promise<void> {
    if (typeof requestAnimationFrame === 'undefined') return Promise.resolve();
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

/**
 * Resolve once frames are flowing: a run of quick frames, or a cap. A new scene's first frames compile
 * its shaders, each a long stall, so lifting a loading screen on "a frame ran" shows exactly the hitch
 * it was hiding. The published player's boot screen waits the same way.
 */
export function whenFramesSmooth(maxFrames = 240): Promise<void> {
    if (typeof requestAnimationFrame === 'undefined') return Promise.resolve();
    return new Promise(resolve => {
        let last = performance.now(), smooth = 0, frames = 0;
        const tick = (now: number) => {
            smooth = now - last < 100 ? smooth + 1 : 0;
            last = now;
            if (smooth >= 10 || ++frames >= maxFrames) { resolve(); return; }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}
