import { Logger } from '../../core/logger';
import { EXTRA_LOGICAL_NAMES, LAZY_LOGICAL_NAMES, physicalFor, splitPhysical, logicalNamesFor, FILTER_DEPENDENT } from '../programVariants';
import type { ShadowFilter } from '../programVariants';
import type { DeviceCapabilities, Device } from '../rhi/device';
import { device } from '../rhi/deviceHandle';
import type { ShaderProgramDescriptor, ShaderProgram } from '../rhi/shaderProgram';
import { ProgramCompileQueue, shaderOptimizerStats, recordStall } from '../shaderOptimizer';
import { shaderStats } from '../shaderStats';
import { programTable } from './programs';
import { setParticleSimVariants } from '../particles/particleRenderer';
import type { PipelineCacheHost } from './pipelineCache';
import { ShaderManager } from '../systems/shaderManager';

/** What ProgramRegistry reads from the renderer that owns it, while those members still live there. */
export interface ProgramRegistryHost {
    readonly capabilities: DeviceCapabilities;
    readonly deviceReady: boolean;
    readonly device: Device;
    /** The project's shadow filter setting, which the variants follow (see {@link ProgramRegistry.variantFilter}). */
    readonly shadowFilterMode: number;
}

/**
 * The shader programs a session has: which the boot builds (all of them in the editor, a published
 * list in a game), build-time variants and the shadow filter their aliases point at, programs built
 * on first use with a stand-in drawing while they compile, and the filter switch that waits for its
 * variants before swapping. Also the program side of PipelineCache: the variant filter, a logical
 * name's physical program, and a program's descriptor. Split out of Renderer.
 */
export class ProgramRegistry implements PipelineCacheHost {
    private readonly _shaderManager = ShaderManager.Instance;

    /**
     * `programs` is a published game's program list (`config.programs`); `shaderVariants` turns on
     * build-time variants without one (`config.shaderVariants`).
     */
    constructor(private readonly _host: ProgramRegistryHost, programs: readonly string[] | undefined,
                shaderVariants: boolean) {
        this.programList = programs ? new Set(programs) : null;
        this.variants = !!programs || shaderVariants;
        // A published list names the filter its variants were built for.
        if (programs?.some(n => /~poisson(\.pom)?$/.test(n))) this.variantFilter = 1;
        if (this.variants) setParticleSimVariants(true);
    }

    /** Build-time variants in use: a published program list, or `config.shaderVariants`. */
    public readonly variants: boolean;

    /** The published program list; null builds every program, as the editor does. */
    public readonly programList: ReadonlySet<string> | null;

    /** The shadow filter the variant aliases point at, which can trail the shadow filter setting mid-swap. */
    public variantFilter: ShadowFilter = 0;

    /** The shadow filter the programs serve right now: the variants' while they are in use, else the setting. */
    public filter(): ShadowFilter {
        return this.variants ? this.variantFilter : (this._host.shadowFilterMode === 1 ? 1 : 0);
    }

    /** A filter change waiting for its variants to finish compiling. */
    private _pendingFilter: ShadowFilter | null = null;

    /** Program-table descriptors by name, for variants and on-demand builds after boot. */
    private readonly _tableDescriptors = new Map<string, Omit<ShaderProgramDescriptor, 'label'>>();

    /** Every program built so far, by descriptor: one source never links twice (terrain has two names). */
    private readonly _builtByDescriptor = new Map<object, ShaderProgram>();

    /** Programs compiling in the background while a stand-in draws. See buildOnDemand. */
    public readonly compileQueue = new ProgramCompileQueue<ShaderProgramDescriptor, ShaderProgram>({
        prepareShaderProgram: d => this._host.device.prepareShaderProgram?.(d),
        isShaderProgramReady: d => this._host.device.isShaderProgramReady?.(d) ?? true,
        createShaderProgram: d => this._host.device.createShaderProgram(d),
    }, () => !!this._host.capabilities?.parallelShaderCompile && !shaderStats.syncEach);

    /**
     * The programs this boot builds. The editor: the whole table, plus the parallax (`pom`) variants
     * for the current shadow filter — those are the only programs that march and write frag_depth, so
     * the base programs never do, and building them up front keeps the first height-mapped material
     * from stalling a frame on a synchronous compile. With variants: each family's base
     * entry is replaced by the variants it needs (for the current shadow filter, or exactly those a
     * published list names), and a published list drops everything it does not name — those build on
     * first use instead (see {@link buildOnDemand}).
     */
    public programsToBuild(): readonly (readonly [string, Omit<ShaderProgramDescriptor, 'label'>])[] {
        const table = programTable();
        for (const [name, descriptor] of table) this._tableDescriptors.set(name, descriptor);
        if (!this.variants) {
            // Every always-variant name, except the lazy ones an opt-in feature builds on first use.
            const pom = new Set(Object.keys(EXTRA_LOGICAL_NAMES).filter(n => !LAZY_LOGICAL_NAMES.has(n))
                                                                 .map(n => this.physicalOf(n)));
            return [...table, ...[...pom].flatMap(physical => {
                const descriptor = this.descriptorFor(physical);
                return descriptor ? [[physical, descriptor] as const] : [];
            })];
        }
        if (this.programList === null) this.variantFilter = this._host.shadowFilterMode === 1 ? 1 : 0;
        const list = this.programList;
        const out: (readonly [string, Omit<ShaderProgramDescriptor, 'label'>])[] = [];
        for (const [name, descriptor] of table) {
            const variants = ProgramRegistry._variantsOf(descriptor);
            const family = [name, ...Object.keys(EXTRA_LOGICAL_NAMES).filter(n => EXTRA_LOGICAL_NAMES[n] === name)];
            if (!variants || !family.some(n => physicalFor(n, 0) !== n)) {
                // No rule picks among these variants (particle sims are chosen per emitter): the base
                // builds as usual, and any variant a published list names builds now too.
                if (!list || list.has(name)) out.push([name, descriptor]);
                if (variants && list) for (const tag of Object.keys(variants))
                    if (list.has(`${name}~${tag}`)) out.push([`${name}~${tag}`, variants[tag]]);
                continue;
            }
            const wanted = list
                ? Object.keys(variants).map(tag => `${name}~${tag}`).filter(p => list.has(p))
                : [...new Set(family.map(n => physicalFor(n, this.variantFilter)))];
            for (const physical of wanted) out.push([physical, variants[splitPhysical(physical)![1]]]);
        }
        return out;
    }

    private static _variantsOf(descriptor: object): Record<string, Omit<ShaderProgramDescriptor, 'label'>> | undefined {
        return (descriptor as { variants?: Record<string, Omit<ShaderProgramDescriptor, 'label'>> }).variants;
    }

    /**
     * The descriptor behind a program name: a table entry, or one of its variants (`name~tag`). Null
     * for a name no table entry provides (custom materials, which register themselves).
     */
    public descriptorFor(name: string): Omit<ShaderProgramDescriptor, 'label'> | null {
        if (this._tableDescriptors.size === 0)
            for (const [n, d] of programTable()) this._tableDescriptors.set(n, d);
        const split = splitPhysical(name);
        if (!split) return this._tableDescriptors.get(name) ?? null;
        const base = this._tableDescriptors.get(split[0]);
        return (base && ProgramRegistry._variantsOf(base)?.[split[1]]) ?? null;
    }

    /**
     * The program a logical name is served by right now. Without variants every name is its own table
     * entry — EXCEPT the parallax names, which always mean the `pom` variant: the base program has the
     * march compiled out, because only a program that marches may write frag_depth.
     */
    public physicalOf(name: string): string {
        if (this.variants) return physicalFor(name, this.variantFilter);
        return name in EXTRA_LOGICAL_NAMES ? physicalFor(name, this._host.shadowFilterMode === 1 ? 1 : 0) : name;
    }

    /** Register `program` as `physical` and as every logical name that currently resolves to it. */
    private _registerProgram(physical: string, program: ShaderProgram): void {
        if (this.variants) {
            for (const name of logicalNamesFor(physical, this.variantFilter)) this._shaderManager.addShader(name, program);
            return;
        }
        this._shaderManager.addShader(physical, program);
        for (const alias in EXTRA_LOGICAL_NAMES)
            if (this.physicalOf(alias) === physical) this._shaderManager.addShader(alias, program);
    }

    /**
     * Build a program the boot did not: a name a published list missed, a particle variant, the other
     * side of a shadow-filter switch. Installed as ShaderManager's resolver, so it runs on the first
     * bind of a name nothing has registered yet. Synchronous, so it is a hitch: a published game whose
     * list is right never gets here, which is why it says so when it does.
     */
    public buildOnDemand(name: string): ShaderProgram | undefined {
        const physical = this.physicalOf(name);
        const existing = this._shaderManager.find(physical);
        if (existing) { this._registerProgram(physical, existing); return existing; }
        const descriptor = this.descriptorFor(physical);
        if (!descriptor) return undefined;
        let program = this._builtByDescriptor.get(descriptor);
        if (program) { this._registerProgram(physical, program); return program; }

        // A VARIANT can be compiled in the background while its family's uber program draws in its place:
        // the base program's runtime branches cover whatever the variant compiled out, so the frame is
        // right (or, for a parallax or wind variant, merely flat or still for a few frames) and nothing
        // stalls. The variant is swapped in under its names the frame its compile finishes.
        const standIn = this._standInFor(physical);
        if (standIn && this.compileQueue.request(physical, { ...descriptor, label: physical }, built => {
            this._builtByDescriptor.set(descriptor, built);
            this._registerProgram(physical, built);
        }, error => Logger.error(`[shaders] '${physical}' failed to compile: ${error}`, 'Renderer'))) {
            if (this.programList)
                Logger.warn(`[shaders] '${physical}' compiling in the background — missing from the published program list`, 'Renderer');
            shaderOptimizerStats.fallbackDraws++;
            return standIn;
        }

        if (this.programList)
            Logger.warn(`[shaders] '${physical}' built on demand — missing from the published program list`, 'Renderer');
        const start = performance.now();
        program = this._host.device.createShaderProgram({ ...descriptor, label: physical });
        shaderOptimizerStats.syncCompiles++;
        recordStall(physical, performance.now() - start);
        this._builtByDescriptor.set(descriptor, program);
        this._registerProgram(physical, program);
        return program;
    }

    /**
     * The program that may draw in a variant's place while it compiles: its family's base (the uber
     * program), else any sibling variant already built — every variant of a family shares its bindings,
     * blocks and vertex inputs by construction (tests/shaderVariants.test.ts). Undefined for a program
     * with no family, which then has to be built on the spot.
     */
    private _standInFor(physical: string): ShaderProgram | undefined {
        const split = splitPhysical(physical);
        if (!split) return undefined;
        const base = split[0];
        const own = this._shaderManager.find(base);
        if (own) return own;
        const prefix = base + '~';
        for (const name of this._shaderManager.registeredShaders) {
            if (name !== physical && name.startsWith(prefix)) return this._shaderManager.find(name);
        }
        return undefined;
    }

    /**
     * Point the filter-dependent programs at `filter`'s variants. Their compiles are submitted now and
     * the aliases swap on a later frame, once all are done, so changing the setting does not stall a
     * frame on a driver that compiles in parallel; the old filter keeps rendering until then.
     */
    public requestVariantFilter(filter: ShadowFilter): void {
        if (!this.variants || !this._host.deviceReady) return;
        if (filter === this.variantFilter) { this._pendingFilter = null; return; }
        this._pendingFilter = filter;
        for (const physical of this._filterSwapTargets(filter)) {
            const descriptor = this.descriptorFor(physical);
            if (descriptor && !this._shaderManager.find(physical))
                this._host.device.prepareShaderProgram?.({ ...descriptor, label: physical });
        }
    }

    /** The variants a switch to `filter` needs: those of every filter-dependent name in use. */
    private _filterSwapTargets(filter: ShadowFilter): string[] {
        const inUse = FILTER_DEPENDENT.filter(n => this._shaderManager.find(n));
        return [...new Set(inUse.map(n => physicalFor(n, filter)))];
    }

    /** Finish a pending filter switch once every program it needs is compiled. Called each frame. */
    public pollVariantFilter(): void {
        const filter = this._pendingFilter;
        if (filter === null) return;
        const targets = this._filterSwapTargets(filter);
        for (const physical of targets) {
            const descriptor = this.descriptorFor(physical);
            if (descriptor && !this._shaderManager.find(physical)
                && !(this._host.device.isShaderProgramReady?.({ ...descriptor, label: physical }) ?? true)) return;
        }
        this.variantFilter = filter;
        this._pendingFilter = null;
        for (const physical of targets) {
            const descriptor = this.descriptorFor(physical);
            if (!descriptor) continue;
            let program = this._shaderManager.find(physical) ?? this._builtByDescriptor.get(descriptor);
            if (!program) {
                program = this._host.device.createShaderProgram({ ...descriptor, label: physical });
                this._builtByDescriptor.set(descriptor, program);
            }
            this._registerProgram(physical, program);
        }
    }

    /**
     * Submit every program's compile and link without waiting, so the driver builds them in parallel.
     * Skipped without the extension (nothing to gain) and under `shaderStats.syncEach`, whose point is
     * timing each program on its own.
     */
    public prefetchPrograms(programs: readonly (readonly [string, Omit<ShaderProgramDescriptor, 'label'>])[]): void {
        if (!this._host.capabilities?.parallelShaderCompile || shaderStats.syncEach) return;
        const prepare = this._host.device.prepareShaderProgram;
        if (!prepare) return;
        const seen = new Set<object>();
        for (const [name, descriptor] of programs) {
            if (seen.has(descriptor)) continue;
            seen.add(descriptor);
            prepare.call(this._host.device, { ...descriptor, label: name });
        }
    }

    /** Whether building `entry` now would not block. Always true when nothing was prefetched. */
    public programReady(entry: readonly [string, Omit<ShaderProgramDescriptor, 'label'>]): boolean {
        if (!this._host.capabilities?.parallelShaderCompile) return true;
        const [name, descriptor] = entry;
        return this._host.device.isShaderProgramReady?.({ ...descriptor, label: name }) ?? true;
    }

    // One program can carry two names, and they must be the SAME object: uniform state lives on the
    // program, so linking the source twice gives two that drift apart silently. `built` remembers them.
    public buildProgram(entry: readonly [string, Omit<ShaderProgramDescriptor, 'label'>],
                          built: Map<Omit<ShaderProgramDescriptor, 'label'>, ShaderProgram>): void {
        const [name, descriptor] = entry;
        let program = built.get(descriptor);
        if (!program) {
            program = this._host.device.createShaderProgram({ ...descriptor, label: name });
            built.set(descriptor, program);
            this._builtByDescriptor.set(descriptor, program);
        }
        this._registerProgram(name, program);
    }
}
