declare module "node:fs" {
  export const copyFileSync: (...args: any[]) => any;
  export const existsSync: (...args: any[]) => any;
  export const mkdirSync: (...args: any[]) => any;
  export const readFileSync: (...args: any[]) => any;
}

declare module "node:os" {
  const os: any;
  export default os;
}

declare module "node:path" {
  const path: any;
  export default path;
}

declare module "node:module" {
  export const createRequire: (...args: any[]) => any;
}

declare module "node:url" {
  export const fileURLToPath: (...args: any[]) => any;
}

declare module "node:crypto" {
  export const createHash: (...args: any[]) => any;
}

declare const Buffer: {
  from: (...args: any[]) => any;
  byteLength: (...args: any[]) => number;
};
