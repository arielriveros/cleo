import { Vec } from "cleo";

export const compToHex = (c: number) => {
  var hex = c.toString(16);
  return hex.length == 1 ? "0" + hex : hex;
};

export const vec3ToHex = (vec: Vec.vec3 | undefined) => {
  if (!vec || vec.length < 3) {
    return "#000000"; // Default to black if undefined
  }
  return "#" + compToHex(Math.round(vec[0] * 255)) + compToHex(Math.round(vec[1] * 255)) + compToHex(Math.round(vec[2] * 255));
};

export const colorToVec3 = (color: string) => {
  return color.match(/[A-Za-z0-9]{2}/g)!.map(function(v) { return parseInt(v, 16) / 255});
};