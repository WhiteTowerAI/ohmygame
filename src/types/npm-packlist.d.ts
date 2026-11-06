declare module "npm-packlist" {
  /** The parts of an Arborist node npm-packlist reads. */
  interface PacklistNode {
    path: string;
    target: PacklistNode;
    isLink: boolean;
    isProjectRoot: boolean;
    package: Record<string, unknown>;
    edgesOut: Map<string, { to: PacklistNode; dev: boolean; peer: boolean }>;
  }
  export default function packlist(tree: PacklistNode, options?: { path?: string }): Promise<string[]>;
}
