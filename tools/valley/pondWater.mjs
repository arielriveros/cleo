// The Valley pond's Water material look (water/waterLook.ts): the clear-lake look a little greener and
// siltier, for a pond in a meadow. Shared by build.mjs (pondVolume) and applyWater.ts.
export const POND_WATER_LOOK = {
    shallowColor: [0.12, 0.30, 0.22],
    deepColor: [0.02, 0.07, 0.06],
    absorption: [0.5, 0.12, 0.1],
    turbidity: 0.3,
    clarity: 4,
    roughness: 0.05,
    shoreFoam: 0.3,
    crestFoam: 0.2,
    caustics: 0.8,
}
