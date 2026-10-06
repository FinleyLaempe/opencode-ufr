// babel-preset-solid, @babel/preset-typescript and @babel/core ship no type
// declarations usable here; the build script only passes option objects, so
// `any` is sufficient.
declare module "babel-preset-solid" {
  const preset: any
  export default preset
}
declare module "@babel/preset-typescript" {
  const preset: any
  export default preset
}
declare module "@babel/core" {
  export function transformSync(code: string, options: any): { code: string | null } | null
}
