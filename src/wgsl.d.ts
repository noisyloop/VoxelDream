declare module "*.wgsl" {
  export const code: string;
  export const doc: import("./render/shaders/doc").ShaderDoc;
  const shader: { code: string; doc: import("./render/shaders/doc").ShaderDoc };
  export default shader;
}
