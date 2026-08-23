/// <reference types="@webgpu/types" />

declare module '*.jpg';
declare module '*.png';
// file-loader hands back a URL string (see editor/webpack.config.js).
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.jpeg';
declare module '*.bmp';
declare module '*.css';