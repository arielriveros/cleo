import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/cleo';
import { ALL_FEATURE_MODULES } from '../src/modules/all';
import { FEATURE_LOADERS } from '../src/modules/loaders';
import { featureFactory, featureNodeParser, isFeatureInstalled, restrictFeatures, setAbsentFeatureNames, featureApiNames } from '../src/core/features/registry';
import { Logger } from '../src/core/logger';
import { Node } from '../src/core/scene/nodes/node';
import { DecalNode } from '../src/core/scene/nodes/decalNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { Scene } from '../src/core/scene/scene';
import { createModuleImporter, resolveScriptModule } from '../src/core/scripting/scriptRuntime';
import {
    RENDER_FACTORY, createNullClouds, createNullDecals, createNullFluids, createNullFog, createNullGi, createNullParticles, createNullFoliage,
} from '../src/graphics/render/featureSubsystems';

// The engine's optional features (src/modules/<id>): what a published game built without one does in its place.
// The player restricts nothing (it installs only what the game was built with); Play in window installs every
// feature and restricts them to the game's, which is what these tests do.

afterEach(() => { restrictFeatures(null); setAbsentFeatureNames(null); });

describe('the optional features', () => {
    it('are all installed by the full engine, and each can load as a chunk of its own', () => {
        for (const m of ALL_FEATURE_MODULES) expect(isFeatureInstalled(m.id), m.id).toBe(true);
        expect(Object.keys(FEATURE_LOADERS).sort()).toEqual(ALL_FEATURE_MODULES.map(m => m.id).sort());
    });

    it('parse their nodes while live, and a left-out feature\'s node as a plain one', () => {
        const json = { type: 'decal', name: 'Scorch', id: 'decal-1' };
        const live = new Scene();
        parseNodeJson(live.root, json);
        expect(live.root.children[0]).toBeInstanceOf(DecalNode);
        expect(live.decals.size).toBe(1);

        const error = vi.spyOn(Logger, 'error');
        restrictFeatures(['sequencer']);
        expect(featureNodeParser('decal')).toBeUndefined();
        const without = new Scene();
        parseNodeJson(without.root, json);
        const node = without.root.children[0];
        expect(node).toBeInstanceOf(Node);
        expect(node).not.toBeInstanceOf(DecalNode);
        expect(without.decals.size).toBe(0);
        // Left out on purpose: no "not installed" error.
        expect(error).not.toHaveBeenCalled();
        error.mockRestore();
    });

    it('take their render subsystems with them, leaving the stand-ins', () => {
        expect(featureFactory(RENDER_FACTORY.decals)).toBeTypeOf('function');
        restrictFeatures([]);
        for (const name of Object.values(RENDER_FACTORY)) expect(featureFactory(name), name).toBeUndefined();
        expect(featureFactory('skinnedCloth')).toBeUndefined();
        expect(featureFactory('fogVolume')).toBeUndefined();
    });

    it('take their scene services with them: no 2D world without 2D physics, asked again once it is back', () => {
        restrictFeatures(['world2d']);
        const scene = new Scene();
        expect(scene.physics2D).toBeNull();
        // A tilemap still parses and lists with the 2D world on.
        parseNodeJson(scene.root, { type: 'tilemap', name: 'Map', id: 'map-1' });
        expect(scene.tilemaps.size).toBe(1);
        // The 2D physics' own nodes do not.
        parseNodeJson(scene.root, { type: 'characterBody2D', name: 'Hero', id: 'hero-1' });
        expect(scene.root.children[1].nodeType).toBe('characterBody2D');
        expect(scene.root.children[1].constructor).toBe(Node);
        restrictFeatures(null);
        expect(scene.physics2D).not.toBeNull();
    });

    it('let it neither rain nor snow without weather', () => {
        restrictFeatures(['particles']);
        const dry = new Scene();
        expect(dry.precipitation.systems).toEqual([]);
        expect(dry.precipitation.haze).toBeNull();
        expect(dry.precipitation.clock).toBe(0);
        dry.precipitation.update(1, 1);
        expect(dry.precipitation.systemOf('rain')).toBeNull();
        restrictFeatures(null);
        expect(new Scene().precipitation.constructor.name).toBe('PrecipitationRig');
    });

    it('stand in with subsystems that draw nothing and keep their settings', () => {
        const fog = createNullFog();
        fog.tileSize = 32;
        expect(fog.render(new Scene())).toBe(false);
        expect(fog.tileSize).toBe(32);
        expect(fog.frameVolumes).toEqual([]);

        const gi = createNullGi();
        gi.enabled = false;
        gi.raysPerFrame = 1024;
        expect([gi.enabled, gi.raysPerFrame, gi.texture, gi.settled, gi.describe()]).toEqual([false, 1024, null, true, []]);
        expect(gi.lightingAt([0, 0, 0], new Float32Array(36))).toBe(0);

        const clouds = createNullClouds();
        expect(clouds.cloudsFBO.colors).toEqual([]);
        expect(clouds.cloudHistory.targets).toEqual([]);
        expect(createNullDecals().surfaceDecals).toEqual([]);
        expect(createNullFluids().traceFBO).toBeNull();
        const foliage = createNullFoliage();
        foliage.foliageCullDistance = 120;
        expect([foliage.foliageCullDistance, foliage.gpuCullingSupported, foliage.prepareCapture(new Scene(), 0, [0, 0, 0], null as any, 1, true)]).toEqual([120, false, false]);
        const particles = createNullParticles();
        particles.precipitationDensity = 0.5;
        expect([particles.precipitationDensity, particles.particleLodDistanceScale, particles.isFlatParticleScene(new Scene())]).toEqual([0.5, 1, false]);
    });
});

describe("a left-out feature's names in scripts", () => {
    it('are there while the feature is live', () => {
        const cleo = resolveScriptModule('cleo');
        expect(cleo.DecalNode).toBe(DecalNode);
        expect(Object.keys(cleo)).toContain('DecalNode');
    });

    it('throw a clear error instead of reading undefined, for node scripts and shared modules alike', () => {
        restrictFeatures(['sequencer']);
        const cleo = resolveScriptModule('cleo');
        expect(() => cleo.DecalNode).toThrow(/'DecalNode' belongs to the Decals feature, which this game was published without/);
        expect(Object.keys(cleo)).not.toContain('DecalNode');
        // A shared script module's 'cleo' inherits from the same module, getters included.
        const shared = createModuleImporter()('cleo');
        expect(() => shared.DecalNode).toThrow(/Decals feature/);
        // The core is untouched, and a live feature's names stay.
        expect(cleo.Scene).toBe(Scene);
        expect(cleo.SequenceNode).toBeDefined();
    });

    it("throw for the names a published game was told about, of a feature its player never installed", () => {
        // What a player gets: no restriction, the feature simply absent, its names from config.absentApi.
        setAbsentFeatureNames({ ProbeWidget: 'Light probes+' });
        const cleo = resolveScriptModule('cleo');
        expect(() => cleo.ProbeWidget).toThrow(/'ProbeWidget' belongs to the Light probes\+ feature/);
        // Never over a name the runtime itself exports.
        setAbsentFeatureNames({ Scene: 'Decals' });
        expect(resolveScriptModule('cleo').Scene).toBe(Scene);
    });

    it('come back when the restriction is lifted', () => {
        restrictFeatures([]);
        expect(() => resolveScriptModule('cleo').DecalNode).toThrow();
        restrictFeatures(null);
        expect(resolveScriptModule('cleo').DecalNode).toBe(DecalNode);
        expect(featureApiNames('decals')).toContain('DecalNode');
    });
});
