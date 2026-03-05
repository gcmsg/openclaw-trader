declare module "js-yaml" {
  export function load(str: string): unknown;
  export function dump(obj: unknown): string;
}
