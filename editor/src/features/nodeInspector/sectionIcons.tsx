// Small inline SVG glyphs (stroke = currentColor, 15px) used as Collapsable section icons across the
// node inspector. No binary assets; they inherit the header's text color.
import React from 'react';

const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
);

export const InfoIcon = () => (<S><circle cx='12' cy='12' r='9' /><path d='M12 11v5' /><path d='M12 8h.01' /></S>);
export const TransformIcon = () => (<S><path d='M12 3v18M3 12h18' /><path d='M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5' /></S>);
export const MaterialIcon = () => (<S><circle cx='12' cy='12' r='9' /><path d='M12 3a9 9 0 0 0 0 18' /><circle cx='9' cy='9' r='1.4' fill='currentColor' stroke='none' /></S>);
export const LightIcon = () => (<S><circle cx='12' cy='12' r='4' /><path d='M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19' /></S>);
export const CameraIcon = () => (<S><path d='M3 8.5A1.5 1.5 0 0 1 4.5 7H8l1.5-2h5L16 7h3.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z' /><circle cx='12' cy='13' r='3.2' /></S>);
export const SpriteIcon = () => (<S><rect x='3' y='4' width='18' height='16' rx='2' /><circle cx='8.5' cy='9' r='1.6' /><path d='M21 16l-5-4-8 6' /></S>);
export const PhysicsIcon = () => (<S><circle cx='7' cy='7' r='3.2' /><rect x='13' y='13' width='7.5' height='7.5' rx='1' /><path d='M9.2 9.2l3.6 3.6' /></S>);
export const ShapeIcon = () => (<S><path d='M12 3l8 4.5v9L12 21l-8-4.5v-9Z' /><path d='M12 3v18M4 7.5l8 4.5 8-4.5' /></S>);
export const VariablesIcon = () => (<S><path d='M8 4c-2.5 1.5-2.5 14.5 0 16M16 4c2.5 1.5 2.5 14.5 0 16' /><path d='M9.5 12h5' /></S>);
export const UniformsIcon = () => (<S><path d='M4 7h10M18 7h2M4 12h4M12 12h8M4 17h13M20 17h0' /><circle cx='15' cy='7' r='1.6' fill='currentColor' stroke='none' /><circle cx='9' cy='12' r='1.6' fill='currentColor' stroke='none' /><circle cx='18' cy='17' r='1.6' fill='currentColor' stroke='none' /></S>);
export const SkyIcon = () => (<S><circle cx='7' cy='8' r='3' /><path d='M4 18h13a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.7-1.3' /></S>);
export const CloudsIcon = () => (<S><path d='M6 16a4 4 0 0 1 .6-7.9A5 5 0 0 1 16 8a3.5 3.5 0 0 1-.5 8Z' /></S>);
export const ProbeIcon = () => (<S><circle cx='12' cy='12' r='4' /><circle cx='12' cy='12' r='9' strokeDasharray='2 3' /></S>);
export const SkyboxIcon = () => (<S><rect x='4' y='4' width='16' height='16' rx='1.5' /><path d='M4 9h16M9 4v16' /></S>);
export const AnimationIcon = () => (<S><path d='M5 12a7 7 0 1 1 2 5' /><path d='M5 21v-4h4' /></S>);
